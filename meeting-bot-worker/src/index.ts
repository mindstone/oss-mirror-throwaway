/**
 * Meeting Bot Worker - Main Entry Point
 * 
 * Features:
 * - Bot creation with Output Media (animated avatar webpage)
 * - Session token generation (JWT) for secure avatar/desktop auth
 * - WebSocket relay via Durable Objects
 * - Multi-user deduplication with override
 * - Transcript retrieval and status tracking
 */

import type { Env, CreateBotRequest, CreateBotResponse, BotData, MeetingData, BotStatus, RelayStatusResponse } from './types';
import { 
  extractMeetingId,
  hashMeetingUrl, 
  sha256, 
  getBotDisplayName, 
  verifyUserAuth, 
  generateSessionToken,
  addCors, 
  handleCors, 
  jsonResponse 
} from './utils';
import { BotRelay } from './relay';

// Re-export Durable Object class
export { BotRelay };

// Constants
const RECALL_BASE_URL = 'https://us-west-2.recall.ai/api/v1';
const DEDUP_TRUST_WINDOW_MS = 60 * 60 * 1000; // 1 hour - trust entries younger than this without validation
// Terminal bot statuses from Recall API - bot has finished and won't produce more data
// See: https://docs.recall.ai/docs/bot-status-change-events
const TERMINAL_BOT_STATUSES = [
  'done',                    // Bot completed successfully
  'call_ended',              // Meeting ended (host ended, kicked, etc.)
  'fatal',                   // Unrecoverable error
  'analysis_done',           // Analysis completed (if enabled)
  'analysis_failed',         // Analysis failed
  'media_expired',           // Recording expired before processing
  'recording_permission_denied', // Bot couldn't record
];
const CLEANUP_MARKER_TTL_SECONDS = 60 * 60; // 1 hour - prevents duplicate webhook processing

/** Read KV TTL from env (wrangler.toml). Cloudflare env vars are strings; parseInt is required. */
function getKvTtlSeconds(env: Env): number {
  const ttl = parseInt(env.KV_TTL_SECONDS || '604800', 10);
  return Number.isNaN(ttl) || ttl <= 0 ? 604800 : ttl;
}

const RECALL_WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

type RecallWebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing_secret' | 'missing_signature' | 'malformed_signature' | 'expired_signature' | 'invalid_signature' };

interface ParsedRecallWebhookSignature {
  timestampSeconds: number;
  signatureHex: string;
}

interface CloudTranscriptSegmentPayload {
  recallBotId: string;
  meetingTitle?: string;
  segments: Array<{
    segmentId: string;
    text: string;
    speaker: string | null;
    timestamp: number;
    isFinal: boolean;
    source: 'recall-bot';
  }>;
}

function parseRecallWebhookSignatureHeader(signatureHeader: string | null): ParsedRecallWebhookSignature | null {
  if (!signatureHeader) return null;

  const parts = signatureHeader.split(',');
  let timestampSeconds: number | null = null;
  let signatureHex: string | null = null;

  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) continue;
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
      }
      timestampSeconds = parsed;
    }
    if (key === 'v1') {
      if (!/^[a-f0-9]{64}$/i.test(value)) {
        return null;
      }
      signatureHex = value.toLowerCase();
    }
  }

  if (timestampSeconds == null || signatureHex == null) {
    return null;
  }

  return {
    timestampSeconds,
    signatureHex,
  };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(signatureBuffer);
}

async function verifyRecallWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): Promise<RecallWebhookVerificationResult> {
  if (!secret) {
    return { ok: false, reason: 'missing_secret' };
  }

  if (!signatureHeader) {
    return { ok: false, reason: 'missing_signature' };
  }

  const parsedSignature = parseRecallWebhookSignatureHeader(signatureHeader);
  if (!parsedSignature) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const nowMs = Date.now();
  const signatureTimestampMs = parsedSignature.timestampSeconds * 1000;
  if (Math.abs(nowMs - signatureTimestampMs) > RECALL_WEBHOOK_SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: 'expired_signature' };
  }

  const signatureBytes = hexToBytes(parsedSignature.signatureHex);
  if (!signatureBytes) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const encoder = new TextEncoder();
  const signedPayload = `${parsedSignature.timestampSeconds}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signedPayload));
  return isValid ? { ok: true } : { ok: false, reason: 'invalid_signature' };
}

function generateCloudHmacNonce(): string {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  return Array.from(nonceBytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isCloudTranscriptForwardingEnabled(env: Env): boolean {
  return env.CLOUD_TRANSCRIPT_FORWARD_ENABLED === 'true';
}

async function forwardTranscriptSegmentToCloud(
  payload: CloudTranscriptSegmentPayload,
  env: Env,
): Promise<void> {
  if (!env.CLOUD_SERVICE_URL) {
    console.warn('[WEBHOOK] CLOUD_SERVICE_URL missing; skipping transcript forward');
    return;
  }
  if (!env.MINDSTONE_TRANSCRIPT_HMAC_SECRET) {
    console.warn('[WEBHOOK] MINDSTONE_TRANSCRIPT_HMAC_SECRET missing; skipping transcript forward');
    return;
  }

  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateCloudHmacNonce();
  const signature = await hmacSha256Hex(
    env.MINDSTONE_TRANSCRIPT_HMAC_SECRET,
    `${timestamp}.${nonce}.${rawBody}`,
  );

  const response = await fetch(`${env.CLOUD_SERVICE_URL}/api/meeting/transcript-segment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mindstone-Timestamp': timestamp,
      'X-Mindstone-Nonce': nonce,
      'X-Mindstone-Signature': signature,
    },
    body: rawBody,
  });

  if (!response.ok) {
    throw new Error(`Cloud transcript forward failed with status ${response.status}`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // Bot management endpoints
      if (url.pathname === '/api/bot' && request.method === 'POST') {
        return addCors(await handleCreateBot(request, env));
      }
      if (url.pathname === '/api/bot/status' && request.method === 'GET') {
        return addCors(await handleGetStatus(request, env));
      }
      if (url.pathname === '/api/transcript' && request.method === 'GET') {
        return addCors(await handleGetTranscript(request, env));
      }
      if (url.pathname === '/api/bot/cancel' && request.method === 'POST') {
        return addCors(await handleCancelBot(request, env));
      }
      
      // Chat endpoints
      if (url.pathname.match(/^\/api\/bot\/[^/]+\/chat$/) && request.method === 'GET') {
        return addCors(await handleGetChat(request, env));
      }
      if (url.pathname.match(/^\/api\/bot\/[^/]+\/chat$/) && request.method === 'POST') {
        return addCors(await handlePostChat(request, env));
      }
      
      // WebSocket relay (route to Durable Object)
      if (url.pathname.match(/^\/relay\/[^/]+$/)) {
        return await handleRelayUpgrade(request, env, url);
      }
      
      // Webhooks
      if (url.pathname === '/webhook/recall' && request.method === 'POST') {
        return await handleRecallWebhook(request, env);
      }
      if (url.pathname === '/webhook/recall/chat' && request.method === 'POST') {
        return await handleChatWebhook(request, env);
      }
      if (url.pathname === '/webhook/recall/transcript' && request.method === 'POST') {
        return await handleTranscriptWebhook(request, env, ctx);
      }
      
      // Desktop SDK Upload endpoints (Plan B local recording)
      if (url.pathname === '/api/upload-session' && request.method === 'POST') {
        return addCors(await handleCreateUploadSession(request, env));
      }
      if (url.pathname === '/api/upload-session/status' && request.method === 'GET') {
        return addCors(await handleGetUploadStatus(request, env));
      }
      if (url.pathname === '/api/upload-session/transcript' && request.method === 'GET') {
        return addCors(await handleGetUploadTranscript(request, env));
      }
      
      // Admin: one-time migration to add transcript webhook to existing scheduled bots
      if (url.pathname === '/api/admin/migrate-transcript-webhook' && request.method === 'POST') {
        return addCors(await handleMigrateTranscriptWebhook(request, env));
      }

      // Health check
      if (url.pathname === '/health') {
        return addCors(jsonResponse({ status: 'ok', timestamp: Date.now() }));
      }

      return addCors(jsonResponse({ error: 'Not found' }, 404));
    } catch (error) {
      console.error('Worker error:', error);
      return addCors(jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Internal error' },
        500
      ));
    }
  },
};

/**
 * Check if a bot is still active by querying Recall API.
 * Returns the bot status code or null if unavailable.
 */
async function getBotStatusFromRecall(botId: string, env: Env): Promise<string | null> {
  try {
    const response = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });
    
    if (!response.ok) {
      // Bot not found or expired - treat as inactive
      if (response.status === 404 || response.status === 403) {
        return 'not_found';
      }
      return null; // Unknown error - can't determine status
    }
    
    const data = await response.json() as {
      status_changes?: Array<{ code: string }>;
    };
    
    const latestStatus = data.status_changes?.[data.status_changes.length - 1];
    if (latestStatus?.code) return latestStatus.code;
    // Empty status_changes = scheduled bot waiting to join (normal for pre-join_at bots)
    if (Array.isArray(data.status_changes) && data.status_changes.length === 0) return 'ready';
    return null;
  } catch (error) {
    console.error('[DEDUP] Error checking bot status:', error);
    return null;
  }
}

/**
 * Create a new bot for a meeting
 */
async function handleCreateBot(request: Request, env: Env): Promise<Response> {
  // Verify user authentication
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await request.json() as CreateBotRequest;
  
  if (!body.meetingUrl || !body.clientSecret) {
    return jsonResponse({ success: false, error: 'Missing required fields' }, 400);
  }

  // Use canonical meeting ID for dedup key when available (Fix 3: URL canonicalization)
  // This ensures consistent dedup between client and server
  // Falls back to URL hash for unknown platforms or invalid URLs
  const canonicalMeetingId = extractMeetingId(body.meetingUrl);
  const meetingUrlHash = canonicalMeetingId ?? await hashMeetingUrl(body.meetingUrl);
  const secretHash = await sha256(body.clientSecret);

  // Check for existing bot (deduplication)
  // Try canonical key first, then fall back to legacy URL hash for backward compatibility
  let existingMeeting = await env.MEETING_BOTS.get<MeetingData>(`meeting:${meetingUrlHash}`, 'json');
  
  // If no match with canonical ID and we used canonical, also check legacy URL hash
  // This handles the transition period where old entries use URL hash
  if (!existingMeeting && canonicalMeetingId) {
    const legacyHash = await hashMeetingUrl(body.meetingUrl);
    if (legacyHash !== meetingUrlHash) {
      existingMeeting = await env.MEETING_BOTS.get<MeetingData>(`meeting:${legacyHash}`, 'json');
      if (existingMeeting) {
        console.log('[DEDUP] Found meeting via legacy URL hash fallback:', {
          canonicalId: canonicalMeetingId,
          legacyHash,
        });
      }
    }
  }
  
  if (existingMeeting && !body.forceJoin) {
    const now = Date.now();
    const entryAge = now - (existingMeeting.createdAt ?? 0);
    const hasCreatedAt = typeof existingMeeting.createdAt === 'number' && existingMeeting.createdAt > 0;
    
    // Determine if entry is stale:
    // - No createdAt (legacy entry): treat as stale
    // - scheduledFor is in the future: NOT stale (covers overnight scheduling)
    // - Entry >1h old with past/unknown scheduledFor: validate with Recall API
    // - Under 1 hour: trust the entry (fresh)
    
    let isStale = false;
    let staleReason = '';
    
    // Parse scheduledFor if available (when the Recall bot will join the meeting)
    const scheduledForMs = existingMeeting.scheduledFor
      ? new Date(existingMeeting.scheduledFor).getTime()
      : NaN;
    
    if (!hasCreatedAt) {
      // Legacy entry without timestamp - treat as stale
      isStale = true;
      staleReason = 'legacy_no_timestamp';
      console.log('[DEDUP] Legacy entry without createdAt, treating as stale:', {
        botId: existingMeeting.botId,
        meetingUrlHash,
      });
    } else if (Number.isFinite(scheduledForMs) && scheduledForMs > now) {
      // Bot is scheduled for a FUTURE meeting — definitely not stale.
      // This covers overnight scheduling where createdAt is 11h+ old but the meeting hasn't started.
      isStale = false;
      console.log('[DEDUP] Bot scheduled for future meeting, not stale:', {
        botId: existingMeeting.botId,
        scheduledFor: existingMeeting.scheduledFor,
        minutesUntilMeeting: ((scheduledForMs - now) / (60 * 1000)).toFixed(0),
      });
    } else if (entryAge > DEDUP_TRUST_WINDOW_MS) {
      // Entry is >1h old AND meeting is in the past or unknown — validate with Recall API.
      // NOTE: Removed the DEDUP_MAX_AGE_MS (8h) hard cutoff. Always validate via API instead of
      // assuming "too old = stale". The hard cutoff caused false stale for overnight scheduling.
      console.log('[DEDUP] Entry in validation window, checking Recall API:', {
        botId: existingMeeting.botId,
        ageMinutes: (entryAge / (60 * 1000)).toFixed(0),
        scheduledFor: existingMeeting.scheduledFor ?? 'unknown',
      });
      
      const botStatus = await getBotStatusFromRecall(existingMeeting.botId, env);
      
      if (botStatus === 'not_found' || (botStatus && TERMINAL_BOT_STATUSES.includes(botStatus))) {
        isStale = true;
        staleReason = `recall_status_${botStatus}`;
        console.log('[DEDUP] Bot is inactive per Recall API:', {
          botId: existingMeeting.botId,
          status: botStatus,
        });
      } else if (botStatus) {
        // Bot is still active
        console.log('[DEDUP] Bot is still active per Recall API:', {
          botId: existingMeeting.botId,
          status: botStatus,
        });
      } else {
        // Couldn't determine status - fail open (allow new bot to prevent blocking user)
        // This is safer than blocking the user when we can't verify
        isStale = true;
        staleReason = 'recall_api_unavailable';
        console.log('[DEDUP] Could not verify bot status, failing open:', {
          botId: existingMeeting.botId,
        });
      }
    } else {
      // Fresh entry (< 1 hour) - trust it
      console.log('[DEDUP] Fresh entry, trusting dedup:', {
        botId: existingMeeting.botId,
        ageMinutes: (entryAge / (60 * 1000)).toFixed(0),
      });
    }
    
    // If stale, clean up and proceed to create new bot
    if (isStale) {
      console.log('[DEDUP] Cleaning up stale entry:', {
        botId: existingMeeting.botId,
        reason: staleReason,
        meetingUrlHash,
      });

      // Cancel the orphaned Recall bot BEFORE creating a new one.
      // Without this, the old bot still has join_at set and will join the meeting,
      // resulting in duplicate Rebels visible in the call.
      // Use leave_call for in-call bots; DELETE for scheduled bots that haven't joined yet.
      try {
        let cancelRes = await fetch(`${RECALL_BASE_URL}/bot/${existingMeeting.botId}/leave_call`, {
          method: 'POST',
          headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
        });
        if (!cancelRes.ok) {
          // leave_call may fail for scheduled bots that haven't joined — try DELETE
          cancelRes = await fetch(`${RECALL_BASE_URL}/bot/${existingMeeting.botId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
          });
        }
        console.log('[DEDUP] Cancelled orphaned Recall bot:', {
          botId: existingMeeting.botId,
          success: cancelRes.ok,
          status: cancelRes.status,
        });
      } catch (cancelError) {
        // Best-effort — don't block new bot creation if cancel fails
        console.error('[DEDUP] Failed to cancel orphaned bot (best-effort):', {
          botId: existingMeeting.botId,
          error: cancelError instanceof Error ? cancelError.message : String(cancelError),
        });
      }

      await env.MEETING_BOTS.delete(`meeting:${meetingUrlHash}`);
      // Fall through to create new bot
    } else {
      // Valid dedup - return existing bot info
      const isSameUser = existingMeeting.ownerUserId === userId;
      const hasOwnerUserId = typeof existingMeeting.ownerUserId === 'string' && existingMeeting.ownerUserId.length > 0;
      
      // Fix 2: Log legacy entries that lack ownerUserId
      if (!hasOwnerUserId) {
        console.log('[DEDUP] Legacy entry without ownerUserId - cannot determine if same user:', {
          botId: existingMeeting.botId,
          meetingUrlHash,
          requestingUserId: userId,
        });
      }
      
      // Use relayBotId for session token and relay URL if available (new bots)
      // Fall back to botId for legacy meetings without relayBotId
      const relayId = existingMeeting.relayBotId ?? existingMeeting.botId;
      
      // Add secretHash for any authenticated user (enables collaborator transcript access)
      // This allows both same-user reconnection AND different users (collaborators) to retrieve transcripts
      // User is already authenticated via verifyUserAuth() at the start of this handler
      const botData = await env.MEETING_BOTS.get<BotData>(`bot:${existingMeeting.botId}`, 'json');
      if (botData) {
        // Only add if not already present (idempotency)
        if (!botData.secretHashes.includes(secretHash)) {
          botData.secretHashes.push(secretHash);
          // Cap at 10 to prevent unbounded growth, but ALWAYS preserve owner (index 0)
          const MAX_SECRET_HASHES = 10;
          if (botData.secretHashes.length > MAX_SECRET_HASHES) {
            // Keep owner's hash (index 0) + most recent collaborators
            botData.secretHashes = [
              botData.secretHashes[0],
              ...botData.secretHashes.slice(-(MAX_SECRET_HASHES - 1))
            ];
            console.log('[DEDUP] Trimmed secretHashes to max (preserved owner):', {
              botId: existingMeeting.botId,
              newCount: botData.secretHashes.length,
            });
          }
          await env.MEETING_BOTS.put(`bot:${existingMeeting.botId}`, JSON.stringify(botData), { expirationTtl: getKvTtlSeconds(env) });
          console.log('[DEDUP] Added secretHash for session:', {
            botId: existingMeeting.botId,
            collaboratorUserId: userId,
            isSameUser,
            isLegacyEntry: !hasOwnerUserId,
            totalSecretHashes: botData.secretHashes.length,
          });
        } else {
          console.log('[DEDUP] SecretHash already registered:', {
            botId: existingMeeting.botId,
            collaboratorUserId: userId,
            isSameUser,
          });
        }
      }
      
      const sessionToken = await generateSessionToken(
        relayId,
        userId,
        meetingUrlHash,
        isSameUser ? 'owner' : 'viewer',
        env
      );
      
      console.log('[CREATE_BOT] Dedup hit (validated):', { 
        isSameUser,
        isLegacyEntry: !hasOwnerUserId,
        hasRelayBotId: !!existingMeeting.relayBotId,
        relayId,
        recallBotId: existingMeeting.botId,
        entryAgeMinutes: (entryAge / (60 * 1000)).toFixed(0),
      });
      
      return jsonResponse<CreateBotResponse>({
        success: true,
        botId: existingMeeting.botId,
        sessionToken,
        relayUrl: `wss://${new URL(request.url).host}/relay/${relayId}`,
        isOwner: isSameUser,
        ownerName: isSameUser ? undefined : existingMeeting.ownerName,
        canOverride: !isSameUser,
      });
    }
  }

  // Get user's display name (uses custom trigger phrase if set)
  const userName = body.userName || 'Unknown';
  const botDisplayName = getBotDisplayName(userName, body.triggerPhrase);
  
  // Generate a unique bot ID prefix that we'll use for the relay
  // This allows us to set up the avatar URL before Recall assigns the actual botId
  // We'll use the meetingUrlHash as a stable identifier
  const relayBotId = `${meetingUrlHash.slice(0, 16)}-${Date.now().toString(36)}`;
  
  console.log('[CREATE_BOT] Generated relayBotId:', relayBotId);
  
  // Calculate token TTL: for scheduled bots, ensure the token is valid when Recall
  // opens the avatar webpage at the scheduled join time (+ 4h buffer for meeting duration).
  // For immediate bots, use the default 4h TTL.
  let avatarTokenTtl: number | undefined;
  if (body.scheduledFor) {
    const scheduledMs = new Date(body.scheduledFor).getTime();
    if (Number.isFinite(scheduledMs)) {
      const leadTimeSeconds = Math.max(0, Math.floor((scheduledMs - Date.now()) / 1000));
      avatarTokenTtl = leadTimeSeconds + 4 * 60 * 60; // lead time + 4h for meeting duration
    } else {
      console.warn('[CREATE_BOT] Invalid scheduledFor date, using default TTL:', body.scheduledFor);
    }
  }

  const sessionToken = await generateSessionToken(
    relayBotId,
    userId,
    meetingUrlHash,
    'owner',
    env,
    avatarTokenTtl
  );
  
  // Build avatar URL with relay info embedded (token/name/title in fragment - not logged for security)
  const avatarPageUrl = buildAvatarUrl(body, userName, relayBotId, sessionToken, request, env);
  
  console.log('[CREATE_BOT] Avatar URL base:', avatarPageUrl.split('#')[0]);

  // Build webhook URLs for real-time events
  const workerHost = new URL(request.url).host;
  const chatWebhookUrl = `https://${workerHost}/webhook/recall/chat`;
  const transcriptWebhookUrl = `https://${workerHost}/webhook/recall/transcript`;
  
  console.log('[CREATE_BOT] Chat webhook URL:', chatWebhookUrl);
  console.log('[CREATE_BOT] Transcript webhook URL:', transcriptWebhookUrl);

  // Create bot via Recall API
  const recallPayload: Record<string, unknown> = {
    meeting_url: body.meetingUrl,
    bot_name: botDisplayName,
    recording_config: {
      transcript: {
        provider: {
          meeting_captions: {}  // Free, immediate, works without webhooks
        }
      },
      // Real-time endpoints for receiving chat messages and live transcript
      realtime_endpoints: [
        {
          type: 'webhook',
          url: chatWebhookUrl,
          events: ['participant_events.chat_message'],
        },
        {
          type: 'webhook',
          url: transcriptWebhookUrl,
          events: ['transcript.data'],
        },
      ],
    },
    output_media: {
      camera: {
        kind: 'webpage',
        config: { url: avatarPageUrl },
      },
    },
    // Use higher-powered bot variant for better video/audio quality
    // web_4_core has 2250 millicores vs default 250 millicores
    variant: {
      zoom: 'web_4_core',
      google_meet: 'web_4_core',
      microsoft_teams: 'web_4_core',
    },
  };

  if (body.scheduledFor) {
    recallPayload.join_at = body.scheduledFor;
  }

  const recallResponse = await fetch(`${RECALL_BASE_URL}/bot/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(recallPayload),
  });

  if (!recallResponse.ok) {
    const errorText = await recallResponse.text();
    console.error('[CREATE_BOT] Recall API error - status:', recallResponse.status);
    console.error('[CREATE_BOT] Recall API error - body:', errorText);

    let recallErrorCode: string | undefined;
    let recallSubCode: string | undefined;
    let recallMessage: string | undefined;
    try {
      const errorBody = JSON.parse(errorText);
      recallErrorCode = errorBody?.code || errorBody?.error?.code;
      recallSubCode = errorBody?.sub_code || errorBody?.error?.sub_code;
      recallMessage = errorBody?.message || errorBody?.error?.message;
    } catch {
      // Error body not JSON — use raw text
    }

    const isRetryable = recallResponse.status === 507 || recallResponse.status === 429;

    return jsonResponse({
      success: false,
      error: recallMessage || 'Failed to create bot',
      recallStatus: recallResponse.status,
      recallErrorCode,
      recallSubCode,
      retryable: isRetryable,
    }, recallResponse.status >= 500 ? 502 : recallResponse.status);
  }

  const recallData = await recallResponse.json() as { id: string };
  const recallBotId = recallData.id;

  // Resolve cloudServiceUrl: use request body if provided, else look up per-user KV (for scheduled bots)
  let cloudServiceUrl = body.cloudServiceUrl;
  if (!cloudServiceUrl) {
    cloudServiceUrl = await env.MEETING_BOTS.get(`user_cloud:${userId}`) ?? undefined;
  }

  // Store bot data (indexed by Recall's botId for transcript/status lookups)
  const botData: BotData = {
    botId: recallBotId,
    meetingUrlHash,
    ownerUserId: userId,
    ownerName: userName,
    secretHashes: [secretHash],
    avatarId: body.avatarId,
    meetingTitle: body.meetingTitle,
    createdAt: Date.now(),
    cloudServiceUrl,
  };
  await env.MEETING_BOTS.put(`bot:${recallBotId}`, JSON.stringify(botData), { expirationTtl: getKvTtlSeconds(env) });

  // Store cloudServiceUrl per-user for reuse by scheduled bots created without desktop
  if (body.cloudServiceUrl) {
    await env.MEETING_BOTS.put(`user_cloud:${userId}`, body.cloudServiceUrl, { expirationTtl: getKvTtlSeconds(env) });
  }

  // Store meeting mapping (for dedup) - use Recall's botId
  // If forceJoin and existingMeeting, preserve the original owner info but increment botCount
  // This ensures that when User B cancels, the meeting entry isn't deleted while User A's bot is still active
  const meetingData: MeetingData = existingMeeting && body.forceJoin ? {
    // Preserve original owner info
    botId: existingMeeting.botId,
    relayBotId: existingMeeting.relayBotId,  // Preserve relay ID if exists
    ownerUserId: existingMeeting.ownerUserId,
    ownerName: existingMeeting.ownerName,
    botCount: (existingMeeting.botCount ?? 1) + 1,
    createdAt: existingMeeting.createdAt,
    scheduledFor: existingMeeting.scheduledFor,  // Preserve on forceJoin
  } : {
    // New meeting entry
    botId: recallBotId,
    relayBotId,  // Store relay ID for dedup reconnection
    ownerUserId: userId,
    ownerName: userName,
    botCount: 1,
    createdAt: Date.now(),
    scheduledFor: body.scheduledFor,  // Store meeting join time for dedup staleness checks
  };
  await env.MEETING_BOTS.put(`meeting:${meetingUrlHash}`, JSON.stringify(meetingData), { expirationTtl: getKvTtlSeconds(env) });

  // Store initial status
  const botStatus: BotStatus = {
    transcriptStatus: 'pending',
    lastUpdated: Date.now(),
  };
  await env.MEETING_BOTS.put(`bot_status:${recallBotId}`, JSON.stringify(botStatus), { expirationTtl: getKvTtlSeconds(env) });

  // Store relay mapping (relayBotId -> recallBotId) so we can look up bot data from relay connections
  await env.MEETING_BOTS.put(`relay:${relayBotId}`, recallBotId, { expirationTtl: getKvTtlSeconds(env) });

  // Store direct recall-to-relay mapping for O(1) webhook lookups (avoids fragile 2-hop chain)
  await env.MEETING_BOTS.put(`recall_relay:${recallBotId}`, relayBotId, { expirationTtl: getKvTtlSeconds(env) });

  const relayUrl = `wss://${new URL(request.url).host}/relay/${relayBotId}`;
  
  console.log('[CREATE_BOT] Success! recallBotId:', recallBotId, 'relayBotId:', relayBotId);
  console.log('[CREATE_BOT] Relay URL for desktop:', relayUrl);

  // Return the Recall botId for transcript operations, but relayBotId for WebSocket relay
  // Desktop needs both: recallBotId for status/transcript polling, relayBotId for relay connection
  return jsonResponse<CreateBotResponse>({
    success: true,
    botId: recallBotId,  // For transcript/status operations
    sessionToken,        // Already generated with relayBotId
    relayUrl,  // For WebSocket relay
    isOwner: true,
  });
}

/**
 * Build avatar webpage URL with all necessary params including relay info.
 * 
 * The session token is passed via URL fragment (#token=xxx) so it's not logged by servers.
 * The relay URL is passed as a query param since it's not sensitive.
 */
function buildAvatarUrl(
  body: CreateBotRequest,
  userName: string,
  botId: string,
  sessionToken: string,
  request: Request,
  env: Env
): string {
  // Base URL for avatar webpage (Cloudflare Pages)
  const baseUrl = 'https://rebel-avatar.pages.dev';
  
  // Build relay URL using current worker's host
  const workerHost = new URL(request.url).host;
  const relayUrl = `wss://${workerHost}/relay/${botId}`;
  
  // Non-sensitive params go in query string
  const params = new URLSearchParams();
  params.set('relay', relayUrl);
  if (body.avatarId) params.set('avatar', body.avatarId);
  
  // Sensitive data (name, title, token, trigger) goes in URL fragment (not logged by servers)
  const fragmentParts = [`token=${sessionToken}`];
  if (userName) fragmentParts.push(`name=${encodeURIComponent(userName)}`);
  if (body.meetingTitle) fragmentParts.push(`title=${encodeURIComponent(body.meetingTitle)}`);
  if (body.triggerPhrase) fragmentParts.push(`trigger=${encodeURIComponent(body.triggerPhrase)}`);
  
  return `${baseUrl}?${params.toString()}#${fragmentParts.join('&')}`;
}

/**
 * Route WebSocket upgrade to Durable Object
 */
async function handleRelayUpgrade(request: Request, env: Env, url: URL): Promise<Response> {
  const botIdMatch = url.pathname.match(/^\/relay\/([^/]+)$/);
  if (!botIdMatch) {
    return jsonResponse({ error: 'Invalid relay path' }, 400);
  }
  
  const botId = botIdMatch[1];
  
  // Get Durable Object for this bot
  const doId = env.BOT_RELAY.idFromName(botId);
  const relay = env.BOT_RELAY.get(doId);
  
  // Forward request to Durable Object
  return await relay.fetch(request);
}

/**
 * Get bot status
 */
async function handleGetStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const botId = url.searchParams.get('botId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!botId || !clientSecret) {
    return jsonResponse({ success: false, error: 'Missing botId or clientSecret' }, 400);
  }

  // Verify secret
  const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
  if (!botData) {
    return jsonResponse({ success: false, error: 'Bot not found' }, 404);
  }

  const secretHash = await sha256(clientSecret);
  if (!botData.secretHashes.includes(secretHash)) {
    return jsonResponse({ success: false, error: 'Invalid secret' }, 403);
  }

  // Get status from Recall
  const recallResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!recallResponse.ok) {
    // Pass through actual Recall status code for desktop to handle appropriately
    // 401/402 = auth/billing issue, 403 = bot expired/deleted, 404 = not found, 429 = rate limited
    const status = recallResponse.status;
    return jsonResponse({
      success: false,
      error: `Recall API error: ${status}`,
      recallStatus: status,
    }, status);
  }

  const recallData = await recallResponse.json() as {
    status_changes: Array<{ code: string; sub_code?: string; created_at: string }>;
    meeting_participants: Array<{ name: string }>;
  };
  
  const latestStatus = recallData.status_changes?.[recallData.status_changes.length - 1];

  // Build base response
  const response: Record<string, unknown> = {
    success: true,
    status: latestStatus?.code || (Array.isArray(recallData.status_changes) && recallData.status_changes.length === 0 ? 'ready' : 'unknown'),
    sub_code: latestStatus?.sub_code,
    statusTimestamp: latestStatus?.created_at,
    participants: recallData.meeting_participants?.map(p => p.name) || [],
  };

  // If relay credentials requested (for restart recovery), mint fresh session token
  const includeRelay = url.searchParams.get('includeRelay') === 'true';
  if (includeRelay) {
    // Look up meeting data to get relayBotId
    const meetingUrlHash = botData.meetingUrlHash;
    const meetingData = await env.MEETING_BOTS.get<MeetingData>(`meeting:${meetingUrlHash}`, 'json');
    
    if (meetingData?.relayBotId) {
      // Determine if this client is the owner (for Q&A role)
      const isOwner = botData.secretHashes[0] === secretHash;
      
      // Use the requesting user's userId for the token (not always the owner).
      // This ensures collaborators get tokens with their own userId for correct
      // multi-desktop Map keying in the relay DO.
      // Owners fall back to ownerUserId for backward compat if auth header is missing.
      // Non-owners MUST have a valid auth header — without it, the token would use
      // ownerUserId, causing Map key collision that could evict the owner's relay socket.
      const authUserId = await verifyUserAuth(request, env);
      if (!isOwner && !authUserId) {
        // Non-owner without valid auth: skip relay credentials to prevent userId collision
        console.log('[GET_STATUS] Skipping relay credentials for non-owner without auth header');
      } else {
        const requestingUserId = authUserId ?? botData.ownerUserId;
      
      // Generate fresh session token
      const sessionToken = await generateSessionToken(
        meetingData.relayBotId,
        requestingUserId,
        meetingUrlHash,
        isOwner ? 'owner' : 'viewer',
        env
      );
      
      response.relayBotId = meetingData.relayBotId;
      response.relayUrl = `wss://${new URL(request.url).host}/relay/${meetingData.relayBotId}`;
      response.sessionToken = sessionToken;
      response.isOwner = isOwner;
      
      console.log('[GET_STATUS] Relay credentials included for restart recovery:', {
        botId,
        relayBotId: meetingData.relayBotId,
        isOwner,
        requestingUserId,
      });
      }
    } else {
      console.log('[GET_STATUS] No relayBotId found for bot (legacy or missing):', botId);
    }
  }

  return jsonResponse(response);
}

/**
 * Get transcript for a bot
 */
async function handleGetTranscript(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const botId = url.searchParams.get('botId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!botId || !clientSecret) {
    return jsonResponse({ success: false, error: 'Missing botId or clientSecret' }, 400);
  }

  // Verify secret
  const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
  if (!botData) {
    return jsonResponse({ success: false, error: 'Bot not found' }, 404);
  }

  const secretHash = await sha256(clientSecret);
  if (!botData.secretHashes.includes(secretHash)) {
    return jsonResponse({ success: false, error: 'Invalid secret' }, 403);
  }

  // Step 1: Fetch bot data to get recording info
  const botResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!botResponse.ok) {
    const status = botResponse.status;
    if (status === 404) {
      return jsonResponse({ success: false, error: 'Bot not found', status: 'no_transcript' }, 404);
    }
    return jsonResponse({
      success: false,
      error: `Recall API error: ${status}`,
      recallStatus: status,
    }, status);
  }

  const botInfo = await botResponse.json() as {
    recordings?: Array<{
      id: string;
      status?: { code: string };
      media_shortcuts?: {
        transcript?: {
          status?: { code: string };
          data?: { download_url?: string };
        };
      };
    }>;
  };

  // Step 2: Check if recording and transcript are available
  const recording = botInfo.recordings?.[0];
  if (!recording) {
    return jsonResponse({ success: false, error: 'No recording available', status: 'no_transcript' });
  }

  const transcriptInfo = recording.media_shortcuts?.transcript;
  if (!transcriptInfo?.data?.download_url) {
    // Transcript not ready yet
    const transcriptStatus = transcriptInfo?.status?.code || 'pending';
    return jsonResponse({ success: false, error: 'Transcript not ready', status: transcriptStatus === 'done' ? 'no_transcript' : 'pending' });
  }

  // Step 3: Fetch transcript from the signed download URL
  const transcriptResponse = await fetch(transcriptInfo.data.download_url);
  if (!transcriptResponse.ok) {
    console.error('[TRANSCRIPT] Failed to fetch from download URL:', transcriptResponse.status);
    return jsonResponse({ success: false, error: 'Failed to download transcript' }, 500);
  }

  const rawSegments = await transcriptResponse.json() as Array<{
    participant?: { name?: string };
    words?: Array<{ text: string; start_timestamp?: { relative?: number }; end_timestamp?: { relative?: number } }>;
  }>;

  if (!Array.isArray(rawSegments)) {
    console.error('[TRANSCRIPT] Invalid transcript format - not an array');
    return jsonResponse({ success: false, error: 'Invalid transcript format' }, 500);
  }

  // Step 4: Transform to expected format (matching handleGetUploadTranscript)
  const transcriptLines: string[] = [];
  const participants = new Set<string>();
  let totalDuration = 0;

  for (const segment of rawSegments) {
    const speaker = segment.participant?.name || 'Unknown';
    const text = segment.words?.map(w => w.text).join(' ') || '';
    if (text) {
      participants.add(speaker);
      transcriptLines.push(`${speaker}: ${text}`);
    }
    const lastWord = segment.words?.[segment.words.length - 1];
    const endTime = lastWord?.end_timestamp?.relative;
    if (typeof endTime === 'number' && endTime > totalDuration) {
      totalDuration = endTime;
    }
  }

  return jsonResponse({
    success: true,
    transcript: transcriptLines.join('\n'),
    participants: Array.from(participants),
    duration: Math.round(totalDuration),
    status: 'available',
  });
}

/**
 * Cancel/remove a bot
 */
async function handleCancelBot(request: Request, env: Env): Promise<Response> {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await request.json() as { botId: string; clientSecret: string };
  const { botId, clientSecret } = body;

  if (!botId || !clientSecret) {
    return jsonResponse({ success: false, error: 'Missing botId or clientSecret' }, 400);
  }

  // Verify ownership - only the bot owner can cancel, not collaborators
  const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
  if (!botData) {
    return jsonResponse({ success: false, error: 'Bot not found' }, 404);
  }

  const secretHash = await sha256(clientSecret);
  
  // First check: caller must have a valid secret (either owner or collaborator)
  if (!botData.secretHashes.includes(secretHash)) {
    return jsonResponse({ success: false, error: 'Invalid secret' }, 403);
  }
  
  // Second check: caller must be the owner (secretHashes[0] is always the owner)
  // Collaborators can access transcripts but cannot cancel the bot
  if (botData.secretHashes[0] !== secretHash) {
    console.log('[CANCEL_BOT] Collaborator attempted to cancel bot:', {
      botId,
      isCollaborator: true,
      ownerUserId: botData.ownerUserId,
    });
    return jsonResponse({ success: false, error: 'Only the bot owner can cancel' }, 403);
  }

  // Check bot status to decide the correct cancellation method.
  // Bots that haven't joined a call yet (ready, joining_call, in_waiting_room)
  // must be DELETEd — leave_call is a no-op for them and Recall will still
  // dispatch the bot at its scheduled time, creating a zombie.
  const PRE_JOIN_STATUSES = ['ready', 'joining_call', 'in_waiting_room'];
  let recallResponse: Response;

  const statusResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  const needsDelete = !statusResponse.ok || await (async () => {
    const data = await statusResponse.json() as {
      status_changes?: Array<{ code: string }>;
    };
    const latestStatus = data.status_changes?.[data.status_changes.length - 1]?.code;
    return !latestStatus || PRE_JOIN_STATUSES.includes(latestStatus);
  })();

  if (needsDelete) {
    // Bot hasn't joined yet — destroy it entirely to prevent zombie dispatch
    console.log('[CANCEL_BOT] Deleting pre-join bot:', { botId });
    recallResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });
  } else {
    // Bot is in a call — ask it to leave
    recallResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/leave_call`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });
  }

  // Clean up KV (but don't fail if Recall call failed)
  await env.MEETING_BOTS.delete(`bot:${botId}`);
  await env.MEETING_BOTS.delete(`bot_status:${botId}`);
  await env.MEETING_BOTS.delete(`recall_relay:${botId}`);

  // Decrement bot count for meeting
  const meetingData = await env.MEETING_BOTS.get<MeetingData>(`meeting:${botData.meetingUrlHash}`, 'json');
  if (meetingData) {
    meetingData.botCount = Math.max(0, meetingData.botCount - 1);
    if (meetingData.botCount === 0) {
      await env.MEETING_BOTS.delete(`meeting:${botData.meetingUrlHash}`);
    } else {
      await env.MEETING_BOTS.put(
        `meeting:${botData.meetingUrlHash}`,
        JSON.stringify(meetingData),
        { expirationTtl: getKvTtlSeconds(env) }
      );
    }
  }

  return jsonResponse({
    success: true,
    recallSuccess: recallResponse.ok,
  });
}

// Chat message stored in KV
interface StoredChatMessage {
  text: string;
  sender: {
    id: number;
    name: string | null;
    is_host: boolean;
  };
  timestamp: string;
  created_at: string;
}

/**
 * Handle incoming chat message webhook from Recall
 * Stores messages in KV for later retrieval by desktop
 */
async function handleChatWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as {
      event: string;
      data: {
        data: {
          participant: { id: number; name: string | null; is_host: boolean };
          timestamp: { absolute: string; relative: number };
          data: { text: string; to: string };
        };
        bot: { id: string };
      };
    };

    console.log('[CHAT_WEBHOOK] Received event:', body.event);

    if (body.event !== 'participant_events.chat_message') {
      return new Response('OK', { status: 200 });
    }

    const botId = body.data.bot.id;
    const participant = body.data.data.participant;
    const messageData = body.data.data.data;
    const timestamp = body.data.data.timestamp;

    console.log('[CHAT_WEBHOOK] Chat message for bot:', botId, 'from:', participant.name, 'text:', messageData.text);

    // Store message in KV
    const chatKey = `chat:${botId}`;
    const existingMessages = await env.MEETING_BOTS.get<StoredChatMessage[]>(chatKey, 'json') || [];
    
    const newMessage: StoredChatMessage = {
      text: messageData.text,
      sender: {
        id: participant.id,
        name: participant.name,
        is_host: participant.is_host,
      },
      timestamp: timestamp.absolute,
      created_at: new Date().toISOString(),
    };

    existingMessages.push(newMessage);

    // Keep only last 100 messages per meeting
    const trimmedMessages = existingMessages.slice(-100);

    await env.MEETING_BOTS.put(chatKey, JSON.stringify(trimmedMessages), { expirationTtl: getKvTtlSeconds(env) });

    console.log('[CHAT_WEBHOOK] Stored message, total messages:', trimmedMessages.length);

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[CHAT_WEBHOOK] Error:', error);
    return new Response('Error', { status: 500 });
  }
}

/**
 * Handle incoming transcript webhook from Recall (transcript.data events).
 * Transforms the payload and forwards to the relay DO for real-time desktop delivery.
 */
async function handleTranscriptWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const rawBody = await request.text();
    const signatureVerification = await verifyRecallWebhookSignature(
      rawBody,
      request.headers.get('X-Webhook-Signature'),
      env.RECALL_WEBHOOK_SECRET,
    );
    if (!signatureVerification.ok) {
      console.warn('[WEBHOOK] Transcript webhook signature rejected:', {
        reason: signatureVerification.reason,
      });
      return new Response('Unauthorized', { status: 401 });
    }

    const body = JSON.parse(rawBody) as {
      event: string;
      data: {
        bot: { id: string };
        data: {
          words: Array<{ text: string; end_timestamp?: { relative?: number } }>;
          participant: { name: string; id?: number };
        };
      };
    };

    if (body.event !== 'transcript.data') {
      return new Response('OK', { status: 200 });
    }

    const recallBotId = body?.data?.bot?.id;
    if (!recallBotId) {
      console.log('[WEBHOOK] Transcript webhook missing bot ID');
      return new Response('Missing bot ID', { status: 400 });
    }

    const words = body?.data?.data?.words;
    const participant = body?.data?.data?.participant;
    const participantName = participant?.name || 'Unknown';
    if (!words?.length) {
      return new Response('OK', { status: 200 });
    }

    const segmentTimestamp = Date.now();
    const segment = {
      speaker: participantName,
      text: words.map((w: { text: string }) => w.text).join(' '),
      timestamp: segmentTimestamp,
      isFinal: true,
    };

    const wordTextArray = words.map((word) => word.text);
    const segmentId = await sha256(JSON.stringify({
      recallBotId,
      participantId: participant?.id ?? null,
      participantName,
      words: wordTextArray,
    }));

    // Direct mapping first (O(1)), fall back to 2-hop chain for backward compat
    let relayBotId = await env.MEETING_BOTS.get(`recall_relay:${recallBotId}`);
    if (!relayBotId) {
      try {
        const botDataStr = await env.MEETING_BOTS.get(`bot:${recallBotId}`);
        if (botDataStr) {
          const botData = JSON.parse(botDataStr) as BotData;
          if (botData.meetingUrlHash) {
            const meetingDataStr = await env.MEETING_BOTS.get(`meeting:${botData.meetingUrlHash}`);
            if (meetingDataStr) {
              const meetingData = JSON.parse(meetingDataStr) as MeetingData;
              relayBotId = meetingData.relayBotId ?? null;
            }
          }
        }
      } catch (parseError) {
        console.error('[WEBHOOK] Transcript fallback lookup parse error:', parseError);
      }
    }

    if (!relayBotId) {
      console.log('[WEBHOOK] Transcript webhook - no relay bot found for:', recallBotId);
      return new Response('Relay not found', { status: 404 });
    }

    const doId = env.BOT_RELAY.idFromName(relayBotId);
    const doStub = env.BOT_RELAY.get(doId);
    const doResponse = await doStub.fetch(
      new Request(`https://relay/relay/${relayBotId}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: [segment] }),
      })
    );

    if (!doResponse.ok) {
      console.error('[WEBHOOK] DO transcript injection failed:', doResponse.status);
      return new Response('DO injection failed', { status: 500 });
    }

    if (isCloudTranscriptForwardingEnabled(env)) {
      const botData = await env.MEETING_BOTS.get<BotData>(`bot:${recallBotId}`, 'json');
      const forwardPayload: CloudTranscriptSegmentPayload = {
        recallBotId,
        ...(botData?.meetingTitle ? { meetingTitle: botData.meetingTitle } : {}),
        segments: [{
          segmentId,
          text: segment.text,
          speaker: participantName || null,
          timestamp: segmentTimestamp,
          isFinal: true,
          source: 'recall-bot',
        }],
      };

      ctx.waitUntil(
        forwardTranscriptSegmentToCloud(forwardPayload, env).catch((error) => {
          console.error('[WEBHOOK] Failed to forward transcript segment to cloud:', {
            recallBotId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[WEBHOOK] Transcript webhook error:', error);
    return new Response('Internal error', { status: 500 });
  }
}

/**
 * One-time admin migration: add transcript.data webhook to existing scheduled bots
 * that were created before the webhook delivery feature was deployed.
 * Lists all bots from Recall API, filters for those still waiting to join,
 * and PATCHes their realtime_endpoints to include transcript.data.
 */
async function handleMigrateTranscriptWebhook(request: Request, env: Env): Promise<Response> {
  // Admin-only: verify using Recall API key as shared secret
  const adminKey = request.headers.get('X-Admin-Key');
  if (adminKey !== env.RECALL_API_KEY) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    const workerHost = new URL(request.url).host;
    const transcriptWebhookUrl = `https://${workerHost}/webhook/recall/transcript`;

    // List recent bots from Recall (ordered by creation, most recent first)
    const listResponse = await fetch(`${RECALL_BASE_URL}/bot/?ordering=-created_at&limit=50`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (!listResponse.ok) {
      return jsonResponse({ success: false, error: 'Failed to list bots from Recall' }, 500);
    }

    const listData = await listResponse.json() as {
      results: Array<{
        id: string;
        join_at: string | null;
        recording_config: {
          realtime_endpoints?: Array<{ type: string; url: string; events: string[] }>;
        } | null;
      }>;
    };

    const results: Array<{ botId: string; status: string }> = [];

    for (const bot of listData.results) {
      // Skip bots that already have transcript.data webhook
      const hasTranscriptWebhook = bot.recording_config?.realtime_endpoints?.some(
        (ep) => ep.events?.includes('transcript.data')
      );
      if (hasTranscriptWebhook) {
        results.push({ botId: bot.id, status: 'already_has_webhook' });
        continue;
      }

      // Build updated realtime_endpoints (add transcript webhook to existing ones)
      const existingEndpoints = bot.recording_config?.realtime_endpoints || [];
      const updatedEndpoints = [
        ...existingEndpoints,
        { type: 'webhook', url: transcriptWebhookUrl, events: ['transcript.data'] },
      ];

      // PATCH the bot via Recall API
      const patchResponse = await fetch(`${RECALL_BASE_URL}/bot/${bot.id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Token ${env.RECALL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recording_config: { realtime_endpoints: updatedEndpoints },
        }),
      });

      if (patchResponse.ok) {
        // Also add recall_relay mapping if missing
        const existing = await env.MEETING_BOTS.get(`recall_relay:${bot.id}`);
        if (!existing) {
          const botDataStr = await env.MEETING_BOTS.get(`bot:${bot.id}`);
          if (botDataStr) {
            const botData = JSON.parse(botDataStr) as BotData;
            if (botData.meetingUrlHash) {
              const meetingDataStr = await env.MEETING_BOTS.get(`meeting:${botData.meetingUrlHash}`);
              if (meetingDataStr) {
                const meetingData = JSON.parse(meetingDataStr) as MeetingData;
                if (meetingData.relayBotId) {
                  await env.MEETING_BOTS.put(`recall_relay:${bot.id}`, meetingData.relayBotId, { expirationTtl: getKvTtlSeconds(env) });
                }
              }
            }
          }
        }
        results.push({ botId: bot.id, status: 'patched' });
      } else {
        const errorText = await patchResponse.text().catch(() => 'unknown');
        console.error('[MIGRATE] Failed to patch bot:', bot.id, patchResponse.status, errorText);
        results.push({ botId: bot.id, status: `failed_${patchResponse.status}` });
      }
    }

    return jsonResponse({ success: true, results });
  } catch (error) {
    console.error('[MIGRATE] Migration error:', error);
    return jsonResponse({ success: false, error: 'Migration failed' }, 500);
  }
}

/**
 * Get chat messages for a bot (reads from KV, populated by webhook)
 */
async function handleGetChat(request: Request, env: Env): Promise<Response> {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const botIdMatch = url.pathname.match(/^\/api\/bot\/([^/]+)\/chat$/);
  if (!botIdMatch) {
    return jsonResponse({ success: false, error: 'Invalid path' }, 400);
  }
  
  const botId = botIdMatch[1];

  // Verify ownership (only bot owner can read chat)
  const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
  if (!botData) {
    return jsonResponse({ success: false, error: 'Bot not found' }, 404);
  }

  if (botData.ownerUserId !== userId) {
    return jsonResponse({ success: false, error: 'Access denied' }, 403);
  }

  // Get chat messages from KV (populated by webhook)
  const chatKey = `chat:${botId}`;
  const messages = await env.MEETING_BOTS.get<StoredChatMessage[]>(chatKey, 'json') || [];

  return jsonResponse({ success: true, messages });
}

/**
 * Post a chat message to the meeting
 */
async function handlePostChat(request: Request, env: Env): Promise<Response> {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const botIdMatch = url.pathname.match(/^\/api\/bot\/([^/]+)\/chat$/);
  if (!botIdMatch) {
    return jsonResponse({ success: false, error: 'Invalid path' }, 400);
  }
  
  const botId = botIdMatch[1];
  const body = await request.json() as { message: string };

  if (!body.message) {
    return jsonResponse({ success: false, error: 'Missing message' }, 400);
  }

  // Verify ownership (only bot owner can post chat)
  const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
  if (!botData) {
    return jsonResponse({ success: false, error: 'Bot not found' }, 404);
  }

  if (botData.ownerUserId !== userId) {
    return jsonResponse({ success: false, error: 'Access denied' }, 403);
  }

  // Check rate limit (server-side enforcement)
  const rateLimitKey = `ratelimit:chat:${botId}`;
  const rateLimit = await env.MEETING_BOTS.get<{ count: number; lastReset: number; lastMessage: number }>(rateLimitKey, 'json');
  const now = Date.now();
  
  // Rate limits:
  // - Max 10 chat messages per meeting (1 hour window)
  // - Min 5 seconds between messages (anti-spam)
  if (rateLimit) {
    // Per-meeting limit
    if (now - rateLimit.lastReset < 60 * 60 * 1000 && rateLimit.count >= 10) {
      console.log(`Rate limit exceeded for bot ${botId}: ${rateLimit.count} messages`);
      return jsonResponse({ success: false, error: 'Rate limit exceeded (max 10 per meeting)' }, 429);
    }
    // Anti-spam: min 5 seconds between messages
    if (now - rateLimit.lastMessage < 5000) {
      console.log(`Spam protection for bot ${botId}: too fast`);
      return jsonResponse({ success: false, error: 'Too many requests, please wait' }, 429);
    }
  }

  // Post chat to Recall
  const recallResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/send_chat_message`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: body.message }),
  });

  if (!recallResponse.ok) {
    return jsonResponse({ success: false, error: 'Failed to send chat' }, 500);
  }

  // Update rate limit
  const withinWindow = rateLimit && now - rateLimit.lastReset < 60 * 60 * 1000;
  const newRateLimit = {
    count: withinWindow ? rateLimit.count + 1 : 1,
    lastReset: withinWindow ? rateLimit.lastReset : now,
    lastMessage: now,
  };
  await env.MEETING_BOTS.put(rateLimitKey, JSON.stringify(newRateLimit), { expirationTtl: getKvTtlSeconds(env) });

  return jsonResponse({ success: true });
}

// =============================================================================
// Cloud Fallback Analysis
// =============================================================================

/** Threshold: if desktop was last seen more than 5 minutes ago, consider it disconnected */
const DESKTOP_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Sign a payload with HMAC-SHA256 using the shared auth secret.
 * Returns a base64-encoded signature for the X-Webhook-Signature header.
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

/**
 * Check if desktop was connected during the meeting and trigger cloud fallback
 * analysis if not. Called after terminal bot status cleanup.
 *
 * Flow:
 * 1. Resolve cloudServiceUrl (from botData or per-user KV)
 * 2. Query DO status endpoint for desktop presence
 * 3. If desktop was absent, fetch transcript from Recall and POST to cloud
 */
async function maybeTriggerCloudFallback(
  botId: string,
  relayBotId: string,
  botData: BotData,
  env: Env,
): Promise<void> {
  // Resolve cloudServiceUrl: prefer per-bot, fall back to per-user KV
  const cloudServiceUrl = botData.cloudServiceUrl
    ?? await env.MEETING_BOTS.get(`user_cloud:${botData.ownerUserId}`);

  if (!cloudServiceUrl) {
    console.log('[CLOUD_FALLBACK] No cloudServiceUrl for bot, skipping:', { botId });
    return;
  }

  // Query DO status endpoint for desktop presence
  let relayStatus: RelayStatusResponse;
  try {
    const doId = env.BOT_RELAY.idFromName(relayBotId);
    const doStub = env.BOT_RELAY.get(doId);
    const statusResponse = await doStub.fetch(
      new Request(`https://relay/relay/${relayBotId}/status`, { method: 'GET' })
    );
    if (!statusResponse.ok) {
      console.warn('[CLOUD_FALLBACK] DO status check failed:', { botId, relayBotId, status: statusResponse.status });
      return;
    }
    relayStatus = await statusResponse.json() as RelayStatusResponse;
  } catch (error) {
    console.error('[CLOUD_FALLBACK] DO status check error:', {
      botId,
      relayBotId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // If desktop is currently connected, it will handle analysis
  if (relayStatus.desktopConnected) {
    console.log('[CLOUD_FALLBACK] Desktop connected, skipping cloud fallback:', { botId });
    return;
  }

  // If desktop was seen recently (within threshold), it likely handled analysis
  if (relayStatus.desktopLastSeenAt !== null) {
    const timeSinceLastSeen = Date.now() - relayStatus.desktopLastSeenAt;
    if (timeSinceLastSeen < DESKTOP_STALE_THRESHOLD_MS) {
      console.log('[CLOUD_FALLBACK] Desktop seen recently, skipping cloud fallback:', {
        botId,
        desktopLastSeenAt: relayStatus.desktopLastSeenAt,
        timeSinceLastSeenMs: timeSinceLastSeen,
      });
      return;
    }
  }

  // Desktop was absent — trigger cloud fallback
  console.log('[CLOUD_FALLBACK] Desktop absent, triggering cloud fallback:', {
    botId,
    desktopLastSeenAt: relayStatus.desktopLastSeenAt,
    cloudServiceUrl,
  });

  // Fetch transcript from Recall API
  let transcriptText: string;
  let participants: string[];
  try {
    const transcriptResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/transcript/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (!transcriptResponse.ok) {
      console.warn('[CLOUD_FALLBACK] Failed to fetch transcript from Recall:', {
        botId,
        status: transcriptResponse.status,
      });
      // Store pending flag for retry on next webhook
      await env.MEETING_BOTS.put(`cloud_fallback_pending:${botId}`, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
      return;
    }

    const segments = await transcriptResponse.json() as Array<{
      speaker: string;
      words: Array<{ text: string }>;
    }>;

    // Format transcript as plain text (speaker: text lines)
    const lines: string[] = [];
    const speakerSet = new Set<string>();
    for (const segment of segments) {
      const speaker = segment.speaker || 'Unknown';
      speakerSet.add(speaker);
      const text = segment.words?.map(w => w.text).join(' ') || '';
      if (text) {
        lines.push(`${speaker}: ${text}`);
      }
    }
    transcriptText = lines.join('\n');
    participants = Array.from(speakerSet);

    if (!transcriptText) {
      console.log('[CLOUD_FALLBACK] Empty transcript, skipping cloud fallback:', { botId });
      return;
    }
  } catch (error) {
    console.error('[CLOUD_FALLBACK] Transcript fetch error:', {
      botId,
      error: error instanceof Error ? error.message : String(error),
    });
    await env.MEETING_BOTS.put(`cloud_fallback_pending:${botId}`, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
    return;
  }

  // POST transcript to cloud service for fallback analysis
  const payload = JSON.stringify({
    botId,
    userId: botData.ownerUserId,
    meetingTitle: botData.meetingTitle || `Meeting ${new Date().toLocaleDateString()}`,
    transcript: transcriptText,
    participants,
    meetingStartTime: relayStatus.meetingStartTime,
  });

  try {
    const signature = await signPayload(payload, env.MINDSTONE_AUTH_SECRET);
    const cloudResponse = await fetch(`${cloudServiceUrl}/api/meeting/fallback-analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body: payload,
    });

    if (!cloudResponse.ok) {
      console.warn('[CLOUD_FALLBACK] Cloud service POST failed:', {
        botId,
        status: cloudResponse.status,
        cloudServiceUrl,
      });
      // Store pending flag for potential retry
      await env.MEETING_BOTS.put(`cloud_fallback_pending:${botId}`, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
      return;
    }

    console.log('[CLOUD_FALLBACK] Successfully sent transcript to cloud for analysis:', { botId });
  } catch (error) {
    console.error('[CLOUD_FALLBACK] Cloud service POST error:', {
      botId,
      error: error instanceof Error ? error.message : String(error),
    });
    await env.MEETING_BOTS.put(`cloud_fallback_pending:${botId}`, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
  }
}

/**
 * Handle Recall webhooks
 */
async function handleRecallWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    event: string;
    data: {
      bot_id?: string;
      transcript?: { id: string };
      recording?: { id: string };
      status?: { code: string };
    };
  };

  console.log('[WEBHOOK] Recall webhook:', body.event, 'botId:', body.data?.bot_id);

  const botId = body.data?.bot_id;
  if (!botId) {
    return new Response('OK', { status: 200 });
  }

  // Update status based on event
  const botStatus = await env.MEETING_BOTS.get<BotStatus>(`bot_status:${botId}`, 'json') || {
    transcriptStatus: 'pending',
    lastUpdated: Date.now(),
  };

  switch (body.event) {
    case 'bot.status_change': {
      // Clean up meeting entry when bot reaches terminal state
      // This prevents stale entries from causing false dedup hits on recurring meetings
      const statusCode = body.data.status?.code;
      if (statusCode && TERMINAL_BOT_STATUSES.includes(statusCode)) {
        // Idempotency guard: check if we already processed cleanup for this bot
        // This prevents duplicate decrements if Recall retries webhooks or sends multiple terminal events
        const cleanupMarkerKey = `cleaned:${botId}`;
        const alreadyCleaned = await env.MEETING_BOTS.get(cleanupMarkerKey);
        if (alreadyCleaned) {
          console.log('[WEBHOOK] Already cleaned up this bot, skipping:', { botId, status: statusCode });
          break;
        }
        
        // Look up relayBotId BEFORE cleanup deletes the recall_relay mapping
        const relayBotId = await env.MEETING_BOTS.get(`recall_relay:${botId}`);

        const botData = await env.MEETING_BOTS.get<BotData>(`bot:${botId}`, 'json');
        if (botData?.meetingUrlHash) {
          const meetingData = await env.MEETING_BOTS.get<MeetingData>(`meeting:${botData.meetingUrlHash}`, 'json');
          
          // Validate that the meeting entry belongs to THIS bot (not a newer occurrence of recurring meeting)
          // This prevents late webhooks from old bots affecting current meeting entries
          if (meetingData && meetingData.botId === botId) {
            console.log('[WEBHOOK] Bot reached terminal state, cleaning up meeting entry:', {
              botId,
              status: statusCode,
              meetingUrlHash: botData.meetingUrlHash,
            });
            
            // Mark this bot as cleaned BEFORE modifying state (idempotency)
            await env.MEETING_BOTS.put(cleanupMarkerKey, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
            await env.MEETING_BOTS.delete(`recall_relay:${botId}`);
            
            // Decrement bot count and delete entry if no more bots
            meetingData.botCount = Math.max(0, (meetingData.botCount ?? 1) - 1);
            if (meetingData.botCount === 0) {
              await env.MEETING_BOTS.delete(`meeting:${botData.meetingUrlHash}`);
              console.log('[WEBHOOK] Deleted meeting entry (no more active bots)');
            } else {
              await env.MEETING_BOTS.put(
                `meeting:${botData.meetingUrlHash}`,
                JSON.stringify(meetingData),
                { expirationTtl: getKvTtlSeconds(env) }
              );
              console.log('[WEBHOOK] Decremented bot count:', meetingData.botCount);
            }
          } else if (meetingData) {
            // Meeting entry exists but belongs to a different bot (newer occurrence)
            console.log('[WEBHOOK] Meeting entry belongs to different bot, skipping cleanup:', {
              webhookBotId: botId,
              meetingBotId: meetingData.botId,
              status: statusCode,
            });
            // Still mark as cleaned to prevent future retries
            await env.MEETING_BOTS.put(cleanupMarkerKey, 'true', { expirationTtl: CLEANUP_MARKER_TTL_SECONDS });
          }
        }

        // Cloud fallback: if desktop was absent during the meeting, send transcript to cloud for analysis
        if (botData && relayBotId) {
          try {
            await maybeTriggerCloudFallback(botId, relayBotId, botData, env);
          } catch (error) {
            // Cloud fallback is best-effort — never block webhook processing
            console.error('[CLOUD_FALLBACK] Unexpected error in cloud fallback:', {
              botId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      break;
    }
      
    case 'bot.transcription.complete':
      botStatus.transcriptStatus = 'complete';
      break;
      
    case 'bot.transcription.async.complete':
      botStatus.transcriptStatus = 'complete';
      if (body.data.transcript?.id) {
        botStatus.asyncTranscriptId = body.data.transcript.id;
      }
      break;
      
    case 'bot.recording.complete':
      if (body.data.recording?.id) {
        botStatus.recordingId = body.data.recording.id;
      }
      break;
  }

  botStatus.lastUpdated = Date.now();
  await env.MEETING_BOTS.put(`bot_status:${botId}`, JSON.stringify(botStatus), { expirationTtl: getKvTtlSeconds(env) });

  return new Response('OK', { status: 200 });
}

// =============================================================================
// Desktop SDK Upload Handlers (Plan B Local Recording)
// =============================================================================

/** KV stored upload session data */
interface UploadSessionData {
  uploadId: string;
  recallUploadId: string;  // Recall's SDK upload ID
  secretHash: string;
  meetingTitle: string;
  ownerUserId: string;
  createdAt: number;
}

/**
 * Create a new Desktop SDK upload session.
 * Proxies to Recall's sdk_upload API and returns upload token.
 */
async function handleCreateUploadSession(request: Request, env: Env): Promise<Response> {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await request.json() as {
    meetingTitle?: string;
    clientSecret: string;
  };

  if (!body.clientSecret) {
    return jsonResponse({ success: false, error: 'Missing clientSecret' }, 400);
  }

  const secretHash = await sha256(body.clientSecret);
  const meetingTitle = body.meetingTitle || 'Local Recording';

  console.log('[UPLOAD_SESSION] Creating upload session:', { meetingTitle, userId });

  // Create SDK upload via Recall API
  const recallResponse = await fetch(`${RECALL_BASE_URL}/sdk_upload/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metadata: {
        meeting_title: meetingTitle,
        user_id: userId,
      },
    }),
  });

  if (!recallResponse.ok) {
    const errorText = await recallResponse.text();
    console.error('[UPLOAD_SESSION] Recall API error:', recallResponse.status, errorText);
    return jsonResponse({ success: false, error: 'Failed to create upload session' }, 500);
  }

  const recallData = await recallResponse.json() as {
    id: string;
    upload_token: string;
    status: { code: string };
  };

  console.log('[UPLOAD_SESSION] Recall upload created:', { id: recallData.id, status: recallData.status?.code });

  // Generate our own uploadId for tracking
  const uploadId = `upload_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

  // Store session data
  const sessionData: UploadSessionData = {
    uploadId,
    recallUploadId: recallData.id,
    secretHash,
    meetingTitle,
    ownerUserId: userId,
    createdAt: Date.now(),
  };

  await env.MEETING_BOTS.put(`upload:${uploadId}`, JSON.stringify(sessionData), { expirationTtl: getKvTtlSeconds(env) });
  // Also store reverse mapping for status lookups by recallUploadId
  await env.MEETING_BOTS.put(`upload_recall:${recallData.id}`, uploadId, { expirationTtl: getKvTtlSeconds(env) });

  return jsonResponse({
    success: true,
    uploadId,
    upload_token: recallData.upload_token,
  });
}

/**
 * Get status of a Desktop SDK upload.
 */
async function handleGetUploadStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!uploadId || !clientSecret) {
    return jsonResponse({ success: false, error: 'Missing uploadId or clientSecret' }, 400);
  }

  // Get session data
  const sessionData = await env.MEETING_BOTS.get<UploadSessionData>(`upload:${uploadId}`, 'json');
  if (!sessionData) {
    return jsonResponse({ success: false, error: 'Upload session not found' }, 404);
  }

  // Verify secret
  const secretHash = await sha256(clientSecret);
  if (sessionData.secretHash !== secretHash) {
    return jsonResponse({ success: false, error: 'Invalid secret' }, 403);
  }

  // Get upload status from Recall
  const recallResponse = await fetch(`${RECALL_BASE_URL}/sdk_upload/${sessionData.recallUploadId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!recallResponse.ok) {
    console.error('[UPLOAD_STATUS] Recall API error:', recallResponse.status);
    return jsonResponse({ success: false, error: 'Failed to get upload status' }, 500);
  }

  const recallData = await recallResponse.json() as {
    id: string;
    status: { code: string; sub_code?: string };
    recording_id?: string;
  };

  const statusCode = recallData.status?.code;
  const uploadFailed = statusCode === 'failed';

  // Upload "complete" only means audio was received. The transcript is generated
  // asynchronously from the recording. Check the recording's media_shortcuts to
  // know whether the transcript text is actually available.
  let transcriptReady = false;
  let transcriptFailed = uploadFailed;

  if (statusCode === 'complete' && recallData.recording_id) {
    const recordingRes = await fetch(`${RECALL_BASE_URL}/recording/${recallData.recording_id}/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (recordingRes.ok) {
      const recordingData = await recordingRes.json() as {
        media_shortcuts?: {
          transcript?: {
            status?: { code: string };
            data?: { download_url?: string };
          };
        };
      };

      const txStatus = recordingData.media_shortcuts?.transcript?.status?.code;
      const hasUrl = !!recordingData.media_shortcuts?.transcript?.data?.download_url;
      transcriptReady = txStatus === 'done' && hasUrl;
      transcriptFailed = txStatus === 'failed';
    }
  }

  return jsonResponse({
    success: true,
    status: statusCode,
    transcriptReady,
    transcriptFailed,
    asyncError: recallData.status?.sub_code,
    recordingId: recallData.recording_id,
  });
}

/**
 * Get transcript for a completed Desktop SDK upload.
 */
async function handleGetUploadTranscript(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!uploadId || !clientSecret) {
    return jsonResponse({ success: false, error: 'Missing uploadId or clientSecret' }, 400);
  }

  // Get session data
  const sessionData = await env.MEETING_BOTS.get<UploadSessionData>(`upload:${uploadId}`, 'json');
  if (!sessionData) {
    return jsonResponse({ success: false, error: 'Upload session not found' }, 404);
  }

  // Verify secret
  const secretHash = await sha256(clientSecret);
  if (sessionData.secretHash !== secretHash) {
    return jsonResponse({ success: false, error: 'Invalid secret' }, 403);
  }

  // Get the upload to check status and get recording_id
  const uploadResponse = await fetch(`${RECALL_BASE_URL}/sdk_upload/${sessionData.recallUploadId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!uploadResponse.ok) {
    console.error('[UPLOAD_TRANSCRIPT] Failed to get upload:', uploadResponse.status);
    return jsonResponse({ success: false, error: 'Upload not found at Recall' }, 404);
  }

  const uploadData = await uploadResponse.json() as {
    id: string;
    status: { code: string };
    recording_id?: string;
    metadata?: { meeting_title?: string };
    created_at?: string;
  };

  if (uploadData.status?.code !== 'complete') {
    return jsonResponse({ success: false, error: 'Upload not complete', status: uploadData.status?.code });
  }

  if (!uploadData.recording_id) {
    return jsonResponse({ success: false, error: 'No recording ID available' });
  }

  // Get the recording to check media_shortcuts for transcript availability.
  // The upload "complete" status only means audio was received; the transcript
  // is generated asynchronously and exposed via media_shortcuts.transcript.
  const recordingResponse = await fetch(`${RECALL_BASE_URL}/recording/${uploadData.recording_id}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!recordingResponse.ok) {
    console.error('[UPLOAD_TRANSCRIPT] Failed to get recording:', recordingResponse.status);
    return jsonResponse({ success: false, error: 'Recording not found' }, 404);
  }

  const recordingData = await recordingResponse.json() as {
    media_shortcuts?: {
      transcript?: {
        status?: { code: string };
        data?: { download_url?: string };
      };
    };
  };

  const transcriptInfo = recordingData.media_shortcuts?.transcript;
  if (!transcriptInfo?.data?.download_url) {
    const transcriptStatus = transcriptInfo?.status?.code || 'pending';
    console.log('[UPLOAD_TRANSCRIPT] Transcript not ready:', { uploadId, transcriptStatus });
    return jsonResponse({ success: false, error: 'Transcript not available yet', status: transcriptStatus });
  }

  // Fetch transcript from the signed download URL (same approach as bot path)
  const transcriptResponse = await fetch(transcriptInfo.data.download_url);

  if (!transcriptResponse.ok) {
    console.error('[UPLOAD_TRANSCRIPT] Failed to fetch from download URL:', transcriptResponse.status);
    return jsonResponse({ success: false, error: 'Failed to download transcript' }, 500);
  }

  const segments = await transcriptResponse.json() as Array<{
    participant?: { name?: string };
    words?: Array<{ text: string; start_timestamp?: { relative?: number }; end_timestamp?: { relative?: number } }>;
  }>;

  if (!Array.isArray(segments)) {
    console.error('[UPLOAD_TRANSCRIPT] Invalid transcript format - not an array');
    return jsonResponse({ success: false, error: 'Invalid transcript format' }, 500);
  }

  // Format transcript as text (same shape as bot-path download URL response)
  const transcriptLines: string[] = [];
  const participants = new Set<string>();
  let totalDuration = 0;

  for (const segment of segments) {
    const speaker = segment.participant?.name || 'Unknown';
    const text = segment.words?.map(w => w.text).join(' ') || '';
    if (text) {
      participants.add(speaker);
      transcriptLines.push(`${speaker}: ${text}`);
    }

    const lastWord = segment.words?.[segment.words.length - 1];
    const endTime = lastWord?.end_timestamp?.relative;
    if (typeof endTime === 'number' && endTime > totalDuration) {
      totalDuration = endTime;
    }
  }

  return jsonResponse({
    success: true,
    transcript: transcriptLines.join('\n'),
    participants: Array.from(participants),
    duration: Math.round(totalDuration),
    meetingTitle: sessionData.meetingTitle || uploadData.metadata?.meeting_title || 'Local Recording',
    startTime: uploadData.created_at || new Date(sessionData.createdAt).toISOString(),
  });
}
