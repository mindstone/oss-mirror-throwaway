/**
 * BotRelay Durable Object
 * 
 * Handles WebSocket connections between desktop app and avatar webpage.
 * Uses hibernation API for efficient long-lived connections.
 * 
 * Each bot instance gets its own Durable Object (keyed by botId).
 */

import type { Env, RelayMessage, BufferedTranscriptSegment } from './types';
import { verifySessionToken } from './utils';

/** Max words to keep in the transcript buffer (~15k ≈ 60-90 min of meeting) */
const MAX_BUFFER_WORDS = 15_000;

interface WebSocketAttachment {
  role: 'desktop' | 'avatar';
  userId: string;
  authenticatedAt: number;
  jwtRole?: 'owner' | 'viewer';
}

export class BotRelay implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  
  // Connected clients
  private desktopSockets: Map<string, WebSocket> = new Map();
  private avatarSocket: WebSocket | null = null;
  
  // Server-initiated heartbeat to detect stale connections
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 55_000; // 55s — just under Cloudflare's 60s idle timeout
  
  // Bot metadata
  private botId: string | null = null;
  private ownerUserId: string | null = null;
  private meetingStartTime: number | null = null;

  // Transcript buffer for cloud fallback and desktop reconnect replay
  private transcriptBuffer: BufferedTranscriptSegment[] = [];
  private bufferWordCount = 0;

  // Desktop presence tracking (persisted across hibernation)
  private desktopConnectedAt: number | null = null;
  private desktopLastSeenAt: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Restore any hibernated connections
    this.state.getWebSockets().forEach(ws => {
      const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
      if (attachment) {
        if (attachment.role === 'desktop' && attachment.userId) {
          // Default to 'owner' for old sockets lacking jwtRole — before multi-desktop support,
          // only owners connected to relay, so any pre-existing hibernated socket is an owner.
          if (!attachment.jwtRole) {
            attachment.jwtRole = 'owner';
            ws.serializeAttachment(attachment);
          }
          this.desktopSockets.set(attachment.userId, ws);
        } else if (attachment.role === 'avatar') {
          this.avatarSocket = ws;
        }
      }
    });

    // Restore persisted state from DO storage (async, blocks concurrent requests)
    this.state.blockConcurrencyWhile(async () => {
      const [buffer, dConnAt, dLastAt, mStart] = await Promise.all([
        this.state.storage.get<BufferedTranscriptSegment[]>('transcriptBuffer'),
        this.state.storage.get<number>('desktopConnectedAt'),
        this.state.storage.get<number>('desktopLastSeenAt'),
        this.state.storage.get<number>('meetingStartTime'),
      ]);
      if (buffer) {
        this.transcriptBuffer = buffer;
        this.bufferWordCount = this.countWords(buffer);
      }
      if (dConnAt) this.desktopConnectedAt = dConnAt;
      if (dLastAt) this.desktopLastSeenAt = dLastAt;
      if (mStart) this.meetingStartTime = mStart;
    });
  }

  /**
   * Handle HTTP requests (WebSocket upgrade or transcript injection)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Extract botId and optional suffix from path (/transcript or /status)
    const pathMatch = url.pathname.match(/^\/relay\/([^/]+)(\/transcript|\/status)?$/);
    if (!pathMatch) {
      console.log('[RELAY] Invalid path:', url.pathname);
      return new Response('Invalid path', { status: 404 });
    }
    
    this.botId = pathMatch[1];
    const suffix = pathMatch[2];
    
    // HTTP POST transcript injection (from worker webhook handler)
    if (request.method === 'POST' && suffix === '/transcript') {
      return this.handleTranscriptInjection(request);
    }
    
    // HTTP GET relay status (for worker to check desktop presence before cloud fallback)
    if (request.method === 'GET' && suffix === '/status') {
      return Response.json({
        desktopConnected: this.hasAnyDesktopConnected(),
        desktopLastSeenAt: this.desktopLastSeenAt,
        bufferSegmentCount: this.transcriptBuffer.length,
        meetingStartTime: this.meetingStartTime,
        desktopCount: this.desktopSockets.size,
      });
    }
    
    console.log('[RELAY] WebSocket upgrade request for botId:', this.botId);
    
    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      console.log('[RELAY] Not a WebSocket upgrade request');
      return new Response('Expected WebSocket', { status: 426 });
    }
    
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    // Accept the WebSocket with hibernation enabled
    this.state.acceptWebSocket(server);
    
    // Mark as unauthenticated initially
    server.serializeAttachment({ role: null, userId: null, authenticatedAt: 0 });
    
    console.log('[RELAY] WebSocket accepted, waiting for auth message');
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle transcript segments injected via HTTP POST from the worker webhook handler.
   * Forwards segments to the desktop client if connected.
   */
  private async handleTranscriptInjection(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { segments: BufferedTranscriptSegment[] };
      
      if (!body.segments?.length) {
        return new Response('OK', { status: 200 });
      }
      
      // Forward to all connected desktops
      this.broadcastToDesktops(JSON.stringify({ v: 1, type: 'transcript', segments: body.segments }));
      
      // Buffer segments for reconnect replay and cloud fallback
      for (const seg of body.segments) {
        this.transcriptBuffer.push(seg);
        this.bufferWordCount += this.segmentWordCount(seg.text);
      }
      
      // Set meeting start time on first transcript (more reliable than desktop auth)
      if (!this.meetingStartTime) {
        this.meetingStartTime = Date.now();
        await this.state.storage.put('meetingStartTime', this.meetingStartTime);
      }
      
      // FIFO eviction if over word cap
      this.evictOldestSegments();
      
      // Persist buffer (batched with eviction)
      await this.state.storage.put('transcriptBuffer', this.transcriptBuffer);
      
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('[RELAY] Transcript injection error:', error);
      return new Response('Internal error', { status: 500 });
    }
  }

  /**
   * Handle WebSocket messages (hibernation-compatible)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      console.log('[RELAY] Received binary message, rejecting');
      ws.send(JSON.stringify({ v: 1, type: 'error', error: 'Binary messages not supported' }));
      return;
    }
    
    let msg: RelayMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      console.log('[RELAY] Invalid JSON received');
      ws.send(JSON.stringify({ v: 1, type: 'error', error: 'Invalid JSON' }));
      return;
    }
    
    console.log('[RELAY] Message received:', msg.type, 'botId:', this.botId);
    
    // Check message version
    if (msg.v !== 1) {
      ws.send(JSON.stringify({ v: 1, type: 'error', error: 'Unsupported message version' }));
      return;
    }
    
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    
    // Handle auth message
    if (msg.type === 'auth') {
      console.log('[RELAY] Auth message received, role:', msg.role);
      await this.handleAuth(ws, msg);
      return;
    }
    
    // All other messages require authentication
    if (!attachment?.role) {
      console.log('[RELAY] Message rejected - not authenticated');
      ws.send(JSON.stringify({ v: 1, type: 'auth_error', error: 'Not authenticated' }));
      return;
    }
    
    // Route message based on type
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ v: 1, type: 'pong' }));
        break;
        
      case 'state':
      case 'play_audio':
      case 'wave':
      case 'celebrate':
      case 'goodbye':
      case 'knowledge_access':
        // Desktop → Avatar messages (owner-only)
        if (attachment.role === 'desktop') {
          if (attachment.jwtRole === 'owner' && this.avatarSocket) {
            console.log(`[RELAY] Forwarding ${msg.type} to avatar`);
            this.avatarSocket.send(message);
          } else if (attachment.jwtRole !== 'owner') {
            console.log(`[RELAY] Dropping ${msg.type} from viewer desktop userId=${attachment.userId}`);
          } else {
            console.log(`[RELAY] Cannot forward ${msg.type} - no avatar connected`);
          }
        }
        break;
        
      case 'transcript':
      case 'chat_message':
      case 'audio_ended':
        // Avatar → Desktop messages (broadcast to all desktops)
        if (attachment.role === 'avatar') {
          this.broadcastToDesktops(message);
        }
        break;
      
      case 'avatar_connected':
        // Ignore - relay already sends this on auth
        // Avatar sends this redundantly after auth_ok
        break;
        
      default:
        // Forward unknown messages to the other peer
        if (attachment.role === 'desktop') {
          // Owner-only gating for desktop→avatar forwarding
          if (attachment.jwtRole === 'owner' && this.avatarSocket) {
            this.avatarSocket.send(message);
          } else if (attachment.jwtRole !== 'owner') {
            console.log(`[RELAY] Dropping unknown message type=${msg.type} from viewer desktop userId=${attachment.userId}`);
          }
        } else if (attachment.role === 'avatar') {
          this.broadcastToDesktops(message);
        }
    }
  }

  /**
   * Handle authentication
   */
  private async handleAuth(ws: WebSocket, msg: RelayMessage): Promise<void> {
    const token = msg.token as string;
    const role = msg.role as 'desktop' | 'avatar';
    
    console.log('[RELAY] handleAuth - role:', role, 'token (first 20):', token?.slice(0, 20) + '...');
    
    if (!token || !role) {
      console.log('[RELAY] Auth failed - missing token or role');
      ws.send(JSON.stringify({ v: 1, type: 'auth_error', error: 'Missing token or role' }));
      return;
    }
    
    // Verify JWT token
    const payload = await verifySessionToken(token, this.env);
    if (!payload) {
      console.log('[RELAY] Auth failed - invalid or expired token');
      ws.send(JSON.stringify({ v: 1, type: 'auth_error', error: 'Invalid or expired token' }));
      return;
    }
    
    console.log('[RELAY] Token verified - payload.botId:', payload.botId, 'this.botId:', this.botId);
    
    // Verify botId matches
    if (payload.botId !== this.botId) {
      console.log('[RELAY] Auth failed - botId mismatch');
      ws.send(JSON.stringify({ v: 1, type: 'auth_error', error: 'Token bot mismatch' }));
      return;
    }
    
    // Security: validate JWT role against declared peer type.
    // An avatar connection requires owner-role JWT (prevents viewer impersonation).
    if (role === 'avatar' && payload.role !== 'owner') {
      console.log('[RELAY] Auth failed - avatar connection requires owner JWT, got:', payload.role);
      ws.send(JSON.stringify({ v: 1, type: 'auth_error', error: 'Insufficient role for avatar' }));
      return;
    }

    // Explicit default for old tokens lacking role field (consistent with hibernation restore)
    const jwtRole: 'owner' | 'viewer' = payload.role ?? 'viewer';

    // Store connection info (including JWT role)
    const attachment: WebSocketAttachment = {
      role,
      userId: payload.userId,
      authenticatedAt: Date.now(),
      jwtRole,
    };
    ws.serializeAttachment(attachment);
    
    // Track connection
    if (role === 'desktop') {
      // If same userId reconnects, set Map entry FIRST, THEN close old socket
      const existingSocket = this.desktopSockets.get(payload.userId);
      this.desktopSockets.set(payload.userId, ws);
      if (existingSocket && existingSocket !== ws) {
        existingSocket.close(1000, 'Replaced by new connection');
      }
      
      // Only set ownerUserId if this is an owner-role connection
      if (jwtRole === 'owner') {
        this.ownerUserId = payload.userId;
      }
      
      // Track desktop presence + meetingStartTime (batched write)
      const now = Date.now();
      this.desktopConnectedAt = now;
      this.desktopLastSeenAt = now;
      if (!this.meetingStartTime) this.meetingStartTime = now;
      await this.state.storage.put({
        desktopConnectedAt: now,
        desktopLastSeenAt: now,
        meetingStartTime: this.meetingStartTime,
      });
    } else if (role === 'avatar') {
      if (this.avatarSocket && this.avatarSocket !== ws) {
        this.avatarSocket.close(1000, 'Replaced by new connection');
      }
      this.avatarSocket = ws;
    }
    
    // Backward-compatible connectedPeers: clamp desktops to 0/1 to preserve legacy semantics
    const avatarIsConnected = this.avatarSocket?.readyState === WebSocket.OPEN;
    const connectedPeers = Math.min(this.desktopSockets.size, 1) + (avatarIsConnected ? 1 : 0);
    
    console.log('[RELAY] Auth success! role:', role, 'jwtRole:', jwtRole, 'connectedPeers:', connectedPeers, 'desktopCount:', this.desktopSockets.size);
    
    // Send auth success with new fields for multi-desktop support
    ws.send(JSON.stringify({
      v: 1,
      type: 'auth_ok',
      botId: this.botId,
      connectedPeers,
      avatarConnected: avatarIsConnected,
      jwtRole,
      desktopCount: this.desktopSockets.size,
    }));
    
    // Start server heartbeat if not already running
    this.startHeartbeat();
    
    // Replay buffered transcript segments to the newly authenticating desktop only
    // (other desktops already have the buffer — no broadcast needed here)
    if (role === 'desktop' && this.transcriptBuffer.length > 0) {
      console.log('[RELAY] Replaying', this.transcriptBuffer.length, 'buffered segments to desktop userId:', payload.userId);
      try {
        ws.send(JSON.stringify({
          v: 1,
          type: 'transcript_buffer',
          segments: this.transcriptBuffer,
        }));
      } catch (err) {
        console.error('[RELAY] Failed to send transcript buffer:', err);
      }
    }
    
    // Notify other peer about connection
    if (role === 'desktop' && this.avatarSocket) {
      console.log('[RELAY] Notifying avatar that desktop connected');
      this.avatarSocket.send(JSON.stringify({ v: 1, type: 'desktop_connected' }));
    } else if (role === 'avatar') {
      // Notify all desktops that avatar connected
      console.log('[RELAY] Notifying desktops that avatar connected');
      this.broadcastToDesktops(JSON.stringify({ v: 1, type: 'avatar_connected' }));
    }
  }

  /**
   * Handle WebSocket close (hibernation-compatible)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    
    // Only clear socket and notify if this is the CURRENT socket (not a replaced one)
    if (attachment?.role === 'desktop' && attachment.userId) {
      // O(1) removal: only delete if this is the current socket for this userId
      if (this.desktopSockets.get(attachment.userId) === ws) {
        this.desktopSockets.delete(attachment.userId);
      }
      // Track when desktop disconnected (awaited to survive hibernation)
      this.desktopLastSeenAt = Date.now();
      await this.state.storage.put('desktopLastSeenAt', this.desktopLastSeenAt);
      // Notify avatar that desktop disconnected only when ALL desktops have left
      if (this.desktopSockets.size === 0 && this.avatarSocket) {
        this.avatarSocket.send(JSON.stringify({ v: 1, type: 'desktop_disconnected' }));
      }
    } else if (attachment?.role === 'avatar' && this.avatarSocket === ws) {
      this.avatarSocket = null;
      // Notify all desktops that avatar disconnected
      this.broadcastToDesktops(JSON.stringify({ v: 1, type: 'avatar_disconnected' }));
    }
    
    // Stop heartbeat if no clients remain
    if (this.desktopSockets.size === 0 && !this.avatarSocket) {
      this.stopHeartbeat();
    }
    
    console.log(`[BotRelay] WebSocket closed: role=${attachment?.role}, userId=${attachment?.userId}, code=${code}, reason=${reason}`);
  }

  /**
   * Handle WebSocket error (hibernation-compatible)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[BotRelay] WebSocket error:', error);
    
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    // Only clear if this is the CURRENT socket (not a replaced one)
    if (attachment?.role === 'desktop' && attachment.userId) {
      if (this.desktopSockets.get(attachment.userId) === ws) {
        this.desktopSockets.delete(attachment.userId);
      }
      this.desktopLastSeenAt = Date.now();
      await this.state.storage.put('desktopLastSeenAt', this.desktopLastSeenAt);
      // Notify avatar when ALL desktops have left (mirrors webSocketClose behavior)
      if (this.desktopSockets.size === 0 && this.avatarSocket) {
        this.avatarSocket.send(JSON.stringify({ v: 1, type: 'desktop_disconnected' }));
      }
    } else if (attachment?.role === 'avatar' && this.avatarSocket === ws) {
      this.avatarSocket = null;
      // Notify all desktops that avatar disconnected (mirrors webSocketClose behavior)
      this.broadcastToDesktops(JSON.stringify({ v: 1, type: 'avatar_disconnected' }));
    }
    
    // Stop heartbeat if no clients remain
    if (this.desktopSockets.size === 0 && !this.avatarSocket) {
      this.stopHeartbeat();
    }
  }

  /**
   * Start server-initiated heartbeat to detect stale connections.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      for (const [userId, ws] of this.desktopSockets) {
        this.sendHeartbeat(ws, `desktop:${userId}`);
      }
      this.sendHeartbeat(this.avatarSocket, 'avatar');
    }, BotRelay.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat when no clients are connected.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a heartbeat ping to a client socket.
   * Uses `server_ping` type to avoid collision with the client-side ping/pong protocol.
   */
  private sendHeartbeat(ws: WebSocket | null, role: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ v: 1, type: 'server_ping', ts: Date.now() }));
    } catch (error) {
      console.error(`[RELAY] Failed to send heartbeat to ${role}:`, error);
    }
  }

  /**
   * Broadcast a message to all connected desktop sockets.
   * Per-socket try/catch ensures one failed send doesn't break the loop.
   * Prunes stale (non-OPEN) sockets during iteration.
   */
  private broadcastToDesktops(message: string): void {
    for (const [userId, ws] of this.desktopSockets) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.desktopSockets.delete(userId);
        continue;
      }
      try {
        ws.send(message);
      } catch (error) {
        console.error(`[RELAY] Failed to send to desktop userId=${userId}:`, error);
        this.desktopSockets.delete(userId);
      }
    }
  }

  /**
   * Check if any desktop socket is currently connected (OPEN state).
   */
  private hasAnyDesktopConnected(): boolean {
    for (const ws of this.desktopSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /** Count words in a single segment's text */
  private segmentWordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  /** Count total words across all buffered segments */
  private countWords(segments: BufferedTranscriptSegment[]): number {
    let count = 0;
    for (const seg of segments) {
      count += this.segmentWordCount(seg.text);
    }
    return count;
  }

  /** Remove oldest segments until buffer is within the word cap */
  private evictOldestSegments(): void {
    while (this.bufferWordCount > MAX_BUFFER_WORDS && this.transcriptBuffer.length > 0) {
      const removed = this.transcriptBuffer.shift()!;
      this.bufferWordCount -= this.segmentWordCount(removed.text);
    }
    // Clamp to prevent drift from rounding
    this.bufferWordCount = Math.max(0, this.bufferWordCount);
  }

  /**
   * Get relay status (for debugging and worker cloud-fallback checks)
   */
  getStatus(): object {
    return {
      botId: this.botId,
      ownerUserId: this.ownerUserId,
      meetingStartTime: this.meetingStartTime,
      desktopConnected: this.hasAnyDesktopConnected(),
      desktopCount: this.desktopSockets.size,
      avatarConnected: this.avatarSocket?.readyState === WebSocket.OPEN,
      desktopLastSeenAt: this.desktopLastSeenAt,
      bufferSegmentCount: this.transcriptBuffer.length,
    };
  }
}
