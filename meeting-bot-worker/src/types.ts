/**
 * Type definitions for Meeting Bot Worker
 */

export interface Env {
  MEETING_BOTS: KVNamespace;  // Same binding as existing worker
  TTS_BUCKET?: R2Bucket;  // Optional - Phase 3a
  BOT_RELAY: DurableObjectNamespace;
  RECALL_API_KEY: string;
  MINDSTONE_AUTH_SECRET: string;
  RECALL_WEBHOOK_SECRET?: string;
  MINDSTONE_TRANSCRIPT_HMAC_SECRET?: string;
  CLOUD_SERVICE_URL?: string;
  CLOUD_TRANSCRIPT_FORWARD_ENABLED?: string;
  JWT_SECRET: string;
  RECALL_BASE_URL: string;
  KV_TTL_SECONDS: string;
}

// Bot creation request
export interface CreateBotRequest {
  meetingUrl: string;
  meetingTitle?: string;
  userName?: string;
  avatarUrl?: string;
  avatarId?: string;  // spark, flame, etc.
  clientSecret: string;
  scheduledFor?: string;
  forceJoin?: boolean;  // Override dedup
  triggerPhrase?: string | null;  // Custom Q&A trigger phrase (becomes bot display name)
  cloudServiceUrl?: string;  // User's cloud service URL for fallback analysis when desktop is offline
}

// Bot creation response
export interface CreateBotResponse {
  success: boolean;
  botId?: string;
  sessionToken?: string;  // JWT for avatar/desktop auth
  relayUrl?: string;  // WebSocket URL for relay
  isOwner: boolean;
  ownerName?: string;  // If not owner, who is
  canOverride?: boolean;
  error?: string;
}

// KV stored bot data
export interface BotData {
  botId: string;
  meetingUrlHash: string;
  ownerUserId: string;
  ownerName: string;
  secretHashes: string[];
  createdAt: number;
  avatarId?: string;
  meetingTitle?: string;
  cloudServiceUrl?: string;  // User's cloud service URL for fallback analysis
}

// KV stored meeting data (for dedup)
export interface MeetingData {
  botId: string;  // Recall's bot ID (for status/transcript)
  relayBotId?: string;  // Relay Durable Object ID (for WebSocket); optional for migration
  ownerUserId: string;
  ownerName: string;
  botCount: number;
  createdAt: number;
  scheduledFor?: string;  // ISO date — when the Recall bot is scheduled to join
}

// KV stored bot status
export interface BotStatus {
  recordingId?: string;
  transcriptStatus: 'pending' | 'processing' | 'complete' | 'error';
  asyncTranscriptId?: string;
  lastUpdated: number;
}

// Session token payload (JWT)
export interface SessionTokenPayload {
  botId: string;
  userId: string;
  role: 'owner' | 'viewer';
  meetingUrlHash: string;
  iat: number;
  exp: number;
}

// WebSocket relay message types
export interface RelayMessage {
  v: 1;
  type: string;
  [key: string]: unknown;
}

export interface AuthMessage extends RelayMessage {
  type: 'auth';
  token: string;
  role: 'desktop' | 'avatar';
}

export interface AuthOkMessage extends RelayMessage {
  type: 'auth_ok';
  botId: string;
  connectedPeers: number;
  avatarConnected?: boolean;
  jwtRole?: 'owner' | 'viewer';
  desktopCount?: number;
}

export interface AuthErrorMessage extends RelayMessage {
  type: 'auth_error';
  error: string;
}

export interface StateMessage extends RelayMessage {
  type: 'state';
  state: string;
  status?: string;
}

export interface PlayAudioMessage extends RelayMessage {
  type: 'play_audio';
  url: string;
  status?: string;
}

export interface CelebrateMessage extends RelayMessage {
  type: 'celebrate';
}

export interface GoodbyeMessage extends RelayMessage {
  type: 'goodbye';
}

export interface KnowledgeAccessMessage extends RelayMessage {
  type: 'knowledge_access';
  enabled: boolean;
}

export interface TranscriptMessage extends RelayMessage {
  type: 'transcript';
  segments: TranscriptSegment[];
}

export interface TranscriptSegment {
  participant: { name: string };
  words: { text: string; end_timestamp: { relative: number } }[];
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
}

export interface PingMessage extends RelayMessage {
  type: 'ping';
}

export interface PongMessage extends RelayMessage {
  type: 'pong';
}

/** Flattened transcript segment stored in the DO buffer (matches worker webhook format) */
export interface BufferedTranscriptSegment {
  speaker: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

/** Sent to desktop on connect with all buffered segments */
export interface TranscriptBufferMessage extends RelayMessage {
  type: 'transcript_buffer';
  segments: BufferedTranscriptSegment[];
}

/** Response from GET /relay/{botId}/status */
export interface RelayStatusResponse {
  desktopConnected: boolean;
  desktopLastSeenAt: number | null;
  bufferSegmentCount: number;
  meetingStartTime: number | null;
  desktopCount?: number;
}
