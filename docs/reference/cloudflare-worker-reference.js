/**
 * Cloudflare Worker: Meeting Bot Transcription Service
 * 
 * Features:
 * - Bot creation with meeting_captions for immediate low-quality transcript
 * - Automatic async transcription upgrade via recallai_async
 * - Multi-user deduplication (one bot per meeting URL)
 * - Per-user secrets with two-phase retrieval tracking
 * - Local recording upload session creation (Desktop SDK)
 * 
 * KV Keys:
 * - bot:{botId} - Auth data (secretHashes, meetingUrlHash)
 * - bot_status:{botId} - Transcript status (recordingId, transcriptStatus, asyncTranscriptId)
 * - bot_user:{botId}:{secretHash} - Per-user retrieval tracking
 * - meeting:{urlHash} - Meeting URL to botId mapping
 * - upload:{uploadId} - Upload session tracking for local recordings
 */

const RECALL_BASE_URL = 'https://us-west-2.recall.ai/api/v1';
const KV_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Convert words array from recording transcript endpoint to segments format.
 * Recording endpoint returns: { transcript: { words: [{ text, speaker, start_time, end_time }, ...] } }
 * We need: [{ participant: { name }, words: [{ text, end_timestamp: { relative } }] }, ...]
 */
function convertWordsToSegments(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  // Group words by speaker
  const segments = [];
  let currentSegment = null;

  for (const word of words) {
    // Guard against malformed array entries
    if (!word) continue;
    
    const speaker = word.speaker || 'Unknown';
    
    if (!currentSegment || currentSegment.participant.name !== speaker) {
      // Start new segment
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = {
        participant: { name: speaker },
        words: [],
      };
    }

    currentSegment.words.push({
      text: word.text || '',
      end_timestamp: { relative: word.end_time || word.start_time || 0 },
    });
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

/**
 * Generate personalized bot display name from user's name.
 * Format: "{firstName}'s Rebel Mindstone"
 * Falls back to "Rebel Mindstone" if name is invalid.
 */
function getBotDisplayName(userName) {
  if (!userName || typeof userName !== 'string') {
    return 'Rebel Mindstone';
  }
  const firstName = userName.trim().split(/\s+/)[0];
  // Require at least 2 chars for personalization
  if (!firstName || firstName.length < 2) {
    return 'Rebel Mindstone';
  }
  // Ensure we stay under 100 char limit (80 + "'s Rebel Mindstone" = 98)
  const truncatedName = firstName.slice(0, 80);
  return `${truncatedName}'s Rebel Mindstone`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      if (url.pathname === '/api/bot' && request.method === 'POST') {
        return addCors(await handleSendBot(request, env));
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
      // Local recording upload session endpoints
      if (url.pathname === '/api/upload-session' && request.method === 'POST') {
        return addCors(await handleCreateUploadSession(request, env));
      }
      if (url.pathname === '/api/upload-session/status' && request.method === 'GET') {
        return addCors(await handleGetUploadStatus(request, env));
      }
      if (url.pathname === '/api/upload-session/transcript' && request.method === 'GET') {
        return addCors(await handleGetUploadTranscript(request, env));
      }
      if (url.pathname === '/webhook/recall' && request.method === 'POST') {
        return await handleRecallWebhook(request, env);
      }
      if (url.pathname === '/health') {
        return addCors(Response.json({ status: 'ok', timestamp: Date.now() }));
      }

      return addCors(Response.json({ error: 'Not found' }, { status: 404 }));
    } catch (error) {
      console.error('Worker error:', error);
      return addCors(Response.json(
        { success: false, error: error.message || 'Internal error' },
        { status: 500 }
      ));
    }
  },
};

function handleCors() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Mindstone-Auth, X-Client-Secret',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCors(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

async function hashMeetingUrl(meetingUrl) {
  const url = new URL(meetingUrl);
  
  // Remove password and tracking params (common across platforms)
  url.searchParams.delete('pwd');           // Zoom password
  url.searchParams.delete('utm_source');
  url.searchParams.delete('utm_medium');
  url.searchParams.delete('utm_campaign');
  url.searchParams.delete('utm_content');
  url.searchParams.delete('utm_term');
  
  // Remove Zoom-specific params that vary between calendar entries and join links
  url.searchParams.delete('jst');           // join session type (e.g., ?jst=2, ?jst=3)
  url.searchParams.delete('omn');           // occurrence meeting number (recurring meetings)
  url.searchParams.delete('zak');           // Zoom Access Key (user-specific auth token)
  url.searchParams.delete('zc');            // Zoom tracking/analytics param
  url.searchParams.delete('uname');         // username hint
  
  // Remove Google Meet params that vary per user/session
  url.searchParams.delete('authuser');      // Google account selector (0, 1, 2, etc.)
  url.searchParams.delete('hs');            // host settings
  
  // Remove Microsoft Teams context params (user/tenant specific)
  // Note: Teams URLs have complex structure; we preserve the core meeting ID in the path
  url.searchParams.delete('context');       // JSON blob with Tid/Oid (tenant/user IDs)
  
  url.hash = '';
  const normalized = url.toString().toLowerCase();

  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashSecret(secret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyUserAuth(request, env) {
  const authHeader = request.headers.get('X-Mindstone-Auth');
  if (!authHeader) return null;

  const parts = authHeader.split(':');
  if (parts.length !== 3) return null;

  const [userId, timestamp, signature] = parts;
  const timestampMs = parseInt(timestamp, 10);
  if (isNaN(timestampMs) || Date.now() - timestampMs > 5 * 60 * 1000) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.USER_HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const toSign = `${userId}:${timestamp}`;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(toSign));
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)));

  if (signature !== expectedSig) return null;
  return userId;
}

async function handleSendBot(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  if (!body.meetingUrl) {
    return Response.json({ success: false, error: 'Missing meetingUrl' }, { status: 400 });
  }

  if (!body.clientSecret) {
    return Response.json({ success: false, error: 'Missing clientSecret' }, { status: 400 });
  }

  const meetingUrlHash = await hashMeetingUrl(body.meetingUrl);
  const secretHash = await hashSecret(body.clientSecret);

  // Check for existing bot on same meeting URL
  const existingMeeting = await env.MEETING_BOTS.get(`meeting:${meetingUrlHash}`, 'json');

  if (existingMeeting) {
    const botRecord = await env.MEETING_BOTS.get(`bot:${existingMeeting.botId}`, 'json');

    if (botRecord && !botRecord.secretHashes.includes(secretHash)) {
      botRecord.secretHashes.push(secretHash);
      await env.MEETING_BOTS.put(
        `bot:${existingMeeting.botId}`,
        JSON.stringify(botRecord),
        { expirationTtl: KV_TTL_SECONDS }
      );
    }

    // Initialize user tracking key
    await env.MEETING_BOTS.put(
      `bot_user:${existingMeeting.botId}:${secretHash}`,
      JSON.stringify({ captionsFetched: false, asyncFetched: false }),
      { expirationTtl: KV_TTL_SECONDS }
    );

    console.log(`Bot already exists for meeting, returning existing: ${existingMeeting.botId}`);
    return Response.json({
      success: true,
      botId: existingMeeting.botId,
      isOwner: false
    });
  }

  // Create bot with meeting_captions (works without webhooks)
  const recallPayload = {
    meeting_url: body.meetingUrl,
    bot_name: getBotDisplayName(body.userName),
    metadata: {
      mindstone_user_id: userId,
      meeting_title: body.meetingTitle || 'Untitled Meeting',
      client_secret: body.clientSecret,
    },
    recording_config: {
      transcript: {
        provider: {
          meeting_captions: {}  // Free, immediate, works without webhooks
        }
      }
    }
  };

  if (body.scheduledFor) {
    recallPayload.join_at = body.scheduledFor;
  }

  if (body.avatarUrl) {
    recallPayload.output_media = {
      camera: {
        kind: 'webpage',
        config: { url: body.avatarUrl },
      },
    };
  }

  // Send intro chat message when bot joins meeting
  // Helps participants understand what Rebel is and where to learn more
  const firstName = body.userName ? body.userName.trim().split(/\s+/)[0] : null;
  const introMessage = firstName
    ? `I'm Rebel — I help ${firstName} build a complete picture of their work. This meeting becomes part of their knowledge, not just notes. rebel.mindstone.com`
    : `I'm Rebel — I help build a complete picture of your work. This meeting becomes part of your knowledge, not just notes. rebel.mindstone.com`;

  recallPayload.chat = {
    on_bot_join: {
      send_to: 'everyone',
      message: introMessage,
    },
  };

  const recallResponse = await fetch(`${RECALL_BASE_URL}/bot/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(recallPayload),
  });

  const responseText = await recallResponse.text();

  if (!recallResponse.ok) {
    console.error(`Recall API error: ${recallResponse.status} - ${responseText}`);
    return Response.json({ success: false, error: `Recall API error: ${recallResponse.status}` }, { status: 500 });
  }

  const bot = JSON.parse(responseText);

  // Store auth data in KV (bot:{botId})
  await env.MEETING_BOTS.put(
    `meeting:${meetingUrlHash}`,
    JSON.stringify({ botId: bot.id }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  await env.MEETING_BOTS.put(
    `bot:${bot.id}`,
    JSON.stringify({
      secretHashes: [secretHash],
      meetingUrlHash: meetingUrlHash,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  // Initialize status tracking (bot_status:{botId}) - recording.done will update with recordingId
  await env.MEETING_BOTS.put(
    `bot_status:${bot.id}`,
    JSON.stringify({
      transcriptStatus: 'pending', // Will become 'captions_ready' after recording.done
    }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  // Initialize user tracking (bot_user:{botId}:{secretHash})
  await env.MEETING_BOTS.put(
    `bot_user:${bot.id}:${secretHash}`,
    JSON.stringify({ captionsFetched: false, asyncFetched: false }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  console.log(`Created new bot: ${bot.id} for meeting hash: ${meetingUrlHash}`);
  return Response.json({ success: true, botId: bot.id, isOwner: true });
}

async function handleGetStatus(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const botId = url.searchParams.get('botId');
  // Support both header (preferred) and query param for clientSecret
  const clientSecret = request.headers.get('X-Client-Secret') || url.searchParams.get('clientSecret');

  if (!botId) {
    return Response.json({ success: false, error: 'Missing botId' }, { status: 400 });
  }

  // Check authorization via KV first (supports multi-user dedup)
  const botRecord = await env.MEETING_BOTS.get(`bot:${botId}`, 'json');
  
  if (botRecord && clientSecret) {
    // KV-based auth with clientSecret
    const secretHash = await hashSecret(clientSecret);
    if (!botRecord.secretHashes.includes(secretHash)) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
  } else if (botRecord && !clientSecret) {
    // Bot exists in KV but no clientSecret provided - require it
    return Response.json({ 
      success: false, 
      error: 'Missing clientSecret (use X-Client-Secret header or clientSecret query param)' 
    }, { status: 400 });
  }

  const botResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!botResponse.ok) {
    return Response.json({ success: false, error: 'Bot not found' }, { status: 404 });
  }

  const bot = await botResponse.json();

  // Fallback auth for legacy bots without KV record (pre-dedup bots)
  if (!botRecord) {
    if (bot.metadata?.mindstone_user_id !== userId) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
  }

  const latestStatus = bot.status_changes?.[bot.status_changes.length - 1];

  // Get transcript status from KV
  const statusRecord = await env.MEETING_BOTS.get(`bot_status:${botId}`, 'json');

  return Response.json({
    success: true,
    botId: bot.id,
    status: latestStatus?.code || 'unknown',
    sub_code: latestStatus?.sub_code,
    statusChangedAt: latestStatus?.created_at,
    transcriptStatus: statusRecord?.transcriptStatus || 'pending',
    asyncUpgradeAvailable: statusRecord?.transcriptStatus === 'async_ready',
  });
}

async function handleGetTranscript(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const botId = url.searchParams.get('botId');
  // Support both header (preferred) and query param (legacy) for clientSecret
  const clientSecret = request.headers.get('X-Client-Secret') || url.searchParams.get('clientSecret');

  if (!botId) {
    return Response.json({ success: false, error: 'Missing botId' }, { status: 400 });
  }

  if (!clientSecret) {
    return Response.json({ success: false, error: 'Missing clientSecret (use X-Client-Secret header)' }, { status: 400 });
  }

  const secretHash = await hashSecret(clientSecret);

  // Get bot auth record
  const botRecord = await env.MEETING_BOTS.get(`bot:${botId}`, 'json');
  
  // Get transcript status
  const statusRecord = await env.MEETING_BOTS.get(`bot_status:${botId}`, 'json');
  
  // Get user retrieval status
  const userKey = `bot_user:${botId}:${secretHash}`;
  const userRecord = await env.MEETING_BOTS.get(userKey, 'json') || { captionsFetched: false, asyncFetched: false };

  // Fetch bot from Recall
  const botResponse = await fetch(`${RECALL_BASE_URL}/bot/${botId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!botResponse.ok) {
    return Response.json({ success: false, error: 'Bot not found' }, { status: 404 });
  }

  const bot = await botResponse.json();

  // Auth check - either via KV or legacy metadata
  if (botRecord) {
    if (!botRecord.secretHashes.includes(secretHash)) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
  } else {
    // Legacy auth
    if (bot.metadata?.mindstone_user_id !== userId) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
    if (bot.metadata?.client_secret && clientSecret !== bot.metadata.client_secret) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
  }

  const recording = bot.recordings?.[0];
  if (!recording) {
    return Response.json({ success: false, error: 'No recording found' }, { status: 404 });
  }

  // Determine which transcript to fetch
  const isAsyncReady = statusRecord?.transcriptStatus === 'async_ready';
  const fetchingAsync = isAsyncReady && userRecord.captionsFetched;

  let transcriptUrl;
  let transcriptQuality;

  if (fetchingAsync && statusRecord?.asyncTranscriptId) {
    // Fetch async transcript by ID
    const asyncResponse = await fetch(`${RECALL_BASE_URL}/transcript/${statusRecord.asyncTranscriptId}/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });
    
    if (asyncResponse.ok) {
      const asyncTranscript = await asyncResponse.json();
      transcriptUrl = asyncTranscript.data?.download_url;
      transcriptQuality = 'recallai_async';
    }
  }

  // Fallback to captions transcript
  if (!transcriptUrl) {
    transcriptUrl = recording.media_shortcuts?.transcript?.data?.download_url;
    transcriptQuality = 'captions';
  }

  if (!transcriptUrl) {
    return Response.json({ success: false, error: 'Transcript not ready yet' }, { status: 404 });
  }

  const transcriptResponse = await fetch(transcriptUrl);
  if (!transcriptResponse.ok) {
    return Response.json({ success: false, error: 'Failed to download transcript' }, { status: 500 });
  }

  const transcript = await transcriptResponse.json();

  // Safely parse transcript with guards against schema drift
  if (!Array.isArray(transcript)) {
    return Response.json({ success: false, error: 'Invalid transcript format' }, { status: 500 });
  }

  const formattedTranscript = transcript.map(segment => {
    const speaker = segment?.participant?.name || 'Unknown';
    const words = Array.isArray(segment?.words) ? segment.words : [];
    const text = words.map(w => w?.text || '').join(' ').trim();
    return text ? `${speaker}: ${text}` : null;
  }).filter(Boolean).join('\n\n');

  const participants = [...new Set(transcript.map(s => s?.participant?.name).filter(Boolean))];

  let duration = 0;
  if (transcript.length > 0) {
    const lastSegment = transcript[transcript.length - 1];
    const words = Array.isArray(lastSegment?.words) ? lastSegment.words : [];
    if (words.length > 0) {
      duration = words[words.length - 1]?.end_timestamp?.relative || 0;
    }
  }

  // Update user retrieval status based on what we ACTUALLY returned (not what we tried)
  if (transcriptQuality === 'recallai_async') {
    userRecord.asyncFetched = true;
  } else {
    userRecord.captionsFetched = true;
  }
  await env.MEETING_BOTS.put(userKey, JSON.stringify(userRecord), { expirationTtl: KV_TTL_SECONDS });

  // Check if fully done (async fetched OR async failed/not happening)
  const fullyDone = userRecord.asyncFetched || 
    statusRecord?.transcriptStatus === 'async_failed' ||
    statusRecord?.transcriptStatus === 'captions_ready' ||
    (userRecord.captionsFetched && !statusRecord);

  if (fullyDone && botRecord) {
    // Remove this user's secret
    botRecord.secretHashes = botRecord.secretHashes.filter(h => h !== secretHash);

    if (botRecord.secretHashes.length === 0) {
      console.log(`All users retrieved, cleaning up KV for bot: ${botId}`);
      await env.MEETING_BOTS.delete(`bot:${botId}`);
      await env.MEETING_BOTS.delete(`meeting:${botRecord.meetingUrlHash}`);
      // Status key will expire via TTL
    } else {
      await env.MEETING_BOTS.put(
        `bot:${botId}`,
        JSON.stringify(botRecord),
        { expirationTtl: KV_TTL_SECONDS }
      );
    }
    await env.MEETING_BOTS.delete(userKey);
  }

  return Response.json({
    success: true,
    transcript: formattedTranscript,
    participants,
    duration: Math.round(duration),
    meetingTitle: bot.metadata?.meeting_title,
    startTime: bot.join_at || bot.created_at,
    recordingId: recording.id,
    transcriptQuality,
    asyncUpgradeAvailable: !fetchingAsync && isAsyncReady,
  });
}

async function handleCancelBot(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  if (!body.botId) {
    return Response.json({ success: false, error: 'Missing botId' }, { status: 400 });
  }

  const botResponse = await fetch(`${RECALL_BASE_URL}/bot/${body.botId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!botResponse.ok) {
    return Response.json({ success: false, error: 'Bot not found' }, { status: 404 });
  }

  const bot = await botResponse.json();

  if (bot.metadata?.mindstone_user_id !== userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  if (bot.metadata?.client_secret) {
    if (!body.clientSecret || body.clientSecret !== bot.metadata.client_secret) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }
  }

  const leaveResponse = await fetch(`${RECALL_BASE_URL}/bot/${body.botId}/leave_call/`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!leaveResponse.ok && leaveResponse.status !== 404) {
    return Response.json({ success: false, error: 'Failed to cancel bot' }, { status: 500 });
  }

  // Clean up KV
  const botRecord = await env.MEETING_BOTS.get(`bot:${body.botId}`, 'json');
  if (botRecord) {
    await env.MEETING_BOTS.delete(`bot:${body.botId}`);
    await env.MEETING_BOTS.delete(`bot_status:${body.botId}`);
    await env.MEETING_BOTS.delete(`meeting:${botRecord.meetingUrlHash}`);
  }

  return Response.json({ success: true });
}

// ============================================================================
// LOCAL RECORDING UPLOAD SESSION HANDLERS
// ============================================================================

/**
 * Create an upload session for local recording via Desktop SDK.
 * This endpoint proxies to Recall's SDK upload API using Mindstone's API key,
 * so users don't need their own Recall credentials.
 * 
 * POST /api/upload-session
 * Body: { meetingTitle?: string, clientSecret: string }
 * Returns: { success: true, uploadId: string, upload_token: string }
 */
async function handleCreateUploadSession(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  if (!body.clientSecret) {
    return Response.json({ success: false, error: 'Missing clientSecret' }, { status: 400 });
  }

  const secretHash = await hashSecret(body.clientSecret);

  // Create upload session with Recall's Desktop SDK API
  // See: https://docs.recall.ai/docs/desktop-sdk-reference
  // IMPORTANT: Must include recording_config.transcript for transcription to work
  const recallPayload = {
    meeting_title: body.meetingTitle || 'Local Recording',
    metadata: {
      mindstone_user_id: userId,
      client_secret_hash: secretHash, // Store hash, not raw secret
      source: 'desktop_sdk_local',
    },
    recording_config: {
      transcript: {
        provider: {
          // Use Deepgram streaming for real-time transcription
          deepgram_streaming: {
            model: 'nova-3-general',
            language: 'en-US',
            smart_format: true,
            punctuate: true,
            profanity_filter: false,
            diarize: true,
          },
        },
      },
    },
  };

  const recallResponse = await fetch(`${RECALL_BASE_URL}/sdk-upload/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.RECALL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(recallPayload),
  });

  const responseText = await recallResponse.text();

  if (!recallResponse.ok) {
    console.error(`Recall SDK upload API error: ${recallResponse.status} - ${responseText}`);
    return Response.json({ 
      success: false, 
      error: `Failed to create upload session: ${recallResponse.status}` 
    }, { status: 500 });
  }

  const uploadSession = JSON.parse(responseText);

  // Store upload session in KV using TWO keys (matches cloud bot pattern):
  // - upload:{id} for auth (never modified by webhooks)
  // - upload_status:{id} for status tracking (webhooks can write here safely)
  // This avoids KV eventual consistency issues where webhook overwrites auth data
  await env.MEETING_BOTS.put(
    `upload:${uploadSession.id}`,
    JSON.stringify({
      secretHash,
      userId,
      meetingTitle: body.meetingTitle || 'Local Recording',
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  await env.MEETING_BOTS.put(
    `upload_status:${uploadSession.id}`,
    JSON.stringify({
      transcriptStatus: 'uploading',
    }),
    { expirationTtl: KV_TTL_SECONDS }
  );

  console.log(`Created upload session: ${uploadSession.id} for user: ${userId}`);

  return Response.json({
    success: true,
    uploadId: uploadSession.id,
    upload_token: uploadSession.upload_token,
  });
}

/**
 * Get status of an upload session.
 * 
 * GET /api/upload-session/status?uploadId=xxx
 * Headers: X-Client-Secret: xxx
 * Returns: { success: true, status: string, transcriptReady: boolean }
 */
async function handleGetUploadStatus(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!uploadId) {
    return Response.json({ success: false, error: 'Missing uploadId' }, { status: 400 });
  }

  if (!clientSecret) {
    return Response.json({ success: false, error: 'Missing X-Client-Secret header' }, { status: 400 });
  }

  const secretHash = await hashSecret(clientSecret);

  // Get upload auth record from KV (separate from status for KV consistency)
  const uploadRecord = await env.MEETING_BOTS.get(`upload:${uploadId}`, 'json');
  
  if (!uploadRecord) {
    return Response.json({ success: false, error: 'Upload session not found' }, { status: 404 });
  }

  // Auth check - uploadRecord.secretHash should always exist for client-created records
  if (uploadRecord.secretHash !== secretHash) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  // Get status record (may be created/updated by webhooks independently)
  const statusRecord = await env.MEETING_BOTS.get(`upload_status:${uploadId}`, 'json') || { transcriptStatus: 'uploading' };

  // Fetch status from Recall
  const recallResponse = await fetch(`${RECALL_BASE_URL}/sdk-upload/${uploadId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!recallResponse.ok) {
    const errorText = await recallResponse.text();
    console.error(`Recall SDK upload status error: ${recallResponse.status} - ${errorText}`);
    return Response.json({ success: false, error: 'Upload not found at Recall' }, { status: 404 });
  }

  const upload = await recallResponse.json();
  
  // Recall API returns status as an object: { code: 'done', sub_code: null, updated_at: ... }
  const statusCode = typeof upload.status === 'object' ? upload.status?.code : upload.status;
  console.log(`Upload status for ${uploadId}: status=${statusCode}, transcript_id=${upload.transcript_id}, recording_id=${upload.recording_id}`);

  // Update status KV if transcript is ready from Recall API
  if (upload.transcript_id && statusRecord.transcriptStatus !== 'ready') {
    statusRecord.transcriptStatus = 'ready';
    statusRecord.transcriptId = upload.transcript_id;
    await env.MEETING_BOTS.put(
      `upload_status:${uploadId}`,
      JSON.stringify(statusRecord),
      { expirationTtl: KV_TTL_SECONDS }
    );
  }

  // Check if transcript is ready:
  // 1. Recall API returns transcript_id directly
  // 2. OR our status KV has transcriptStatus === 'ready' (from transcript.done webhook)
  // 3. OR our status KV has transcriptId set (transcript.done webhook may have set this even if status string lagged)
  let transcriptReady = !!upload.transcript_id || statusRecord.transcriptStatus === 'ready' || !!statusRecord.transcriptId;
  
  // Fallback: If upload is complete but transcript not showing as ready (KV lag),
  // probe the recording transcript endpoint to check if it actually exists
  if (!transcriptReady && upload.recording_id && (statusCode === 'complete' || statusCode === 'done')) {
    try {
      const probeResponse = await fetch(`${RECALL_BASE_URL}/recording/${upload.recording_id}/transcript/`, {
        method: 'HEAD', // Just check if it exists, don't download
        headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
      });
      if (probeResponse.ok) {
        console.log(`Transcript probe succeeded for recording ${upload.recording_id} - marking ready`);
        transcriptReady = true;
        // Update KV so future polls don't need to probe
        statusRecord.transcriptStatus = 'ready';
        await env.MEETING_BOTS.put(
          `upload_status:${uploadId}`,
          JSON.stringify(statusRecord),
          { expirationTtl: KV_TTL_SECONDS }
        );
      }
    } catch (probeError) {
      console.log(`Transcript probe failed for recording ${upload.recording_id}: ${probeError.message}`);
    }
  }
  
  // Debug: log the status record to diagnose eventual consistency issues
  if (!transcriptReady) {
    console.log(`transcriptReady=false: upload.transcript_id=${upload.transcript_id}, statusRecord.transcriptStatus=${statusRecord.transcriptStatus}, statusRecord.transcriptId=${statusRecord.transcriptId}`);
  }
  
  // Check if transcript failed (allows client to fail fast instead of polling forever)
  const transcriptFailed = statusRecord.transcriptStatus === 'failed';
  
  return Response.json({
    success: true,
    uploadId,
    status: statusCode || 'unknown',
    transcriptReady,
    transcriptFailed,
    transcriptId: upload.transcript_id,
    recordingId: upload.recording_id,
    // Expose error details for client UX (e.g., "Transcription failed, try again later")
    asyncError: statusRecord.asyncError || null,
  });
}

/**
 * Get transcript for a completed upload session.
 * 
 * GET /api/upload-session/transcript?uploadId=xxx
 * Headers: X-Client-Secret: xxx
 * Returns: { success: true, transcript: string, participants: [], duration: number }
 */
async function handleGetUploadTranscript(request, env) {
  const userId = await verifyUserAuth(request, env);
  if (!userId) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const clientSecret = request.headers.get('X-Client-Secret');

  if (!uploadId) {
    return Response.json({ success: false, error: 'Missing uploadId' }, { status: 400 });
  }

  if (!clientSecret) {
    return Response.json({ success: false, error: 'Missing X-Client-Secret header' }, { status: 400 });
  }

  const secretHash = await hashSecret(clientSecret);

  // Get upload auth record from KV (separate from status)
  const uploadRecord = await env.MEETING_BOTS.get(`upload:${uploadId}`, 'json');
  
  if (!uploadRecord) {
    return Response.json({ success: false, error: 'Upload session not found' }, { status: 404 });
  }

  // Auth check - uploadRecord.secretHash should always exist for client-created records
  if (uploadRecord.secretHash !== secretHash) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  // Fetch upload details from Recall
  const uploadResponse = await fetch(`${RECALL_BASE_URL}/sdk-upload/${uploadId}/`, {
    headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
  });

  if (!uploadResponse.ok) {
    return Response.json({ success: false, error: 'Upload not found at Recall' }, { status: 404 });
  }

  const upload = await uploadResponse.json();
  console.log(`Fetching transcript for upload ${uploadId}: transcript_id=${upload.transcript_id}, recording_id=${upload.recording_id}, status=${upload.status}`);

  let transcript = null;

  // Try fetching transcript via transcript_id first
  if (upload.transcript_id) {
    const transcriptResponse = await fetch(`${RECALL_BASE_URL}/transcript/${upload.transcript_id}/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (transcriptResponse.ok) {
      const transcriptMeta = await transcriptResponse.json();
      
      if (transcriptMeta.data?.download_url) {
        const downloadResponse = await fetch(transcriptMeta.data.download_url);
        if (downloadResponse.ok) {
          transcript = await downloadResponse.json();
        }
      }
    }
  }

  // Fallback: try fetching recording and using media_shortcuts (per bot_async_transcription sample app)
  if (!transcript && upload.recording_id) {
    console.log(`Trying to fetch transcript via recording media_shortcuts: ${upload.recording_id}`);
    const recordingResponse = await fetch(`${RECALL_BASE_URL}/recording/${upload.recording_id}/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (recordingResponse.ok) {
      const recording = await recordingResponse.json();
      const downloadUrl = recording.media_shortcuts?.transcript?.data?.download_url;
      
      if (downloadUrl) {
        console.log(`Found transcript download_url in media_shortcuts`);
        const downloadResponse = await fetch(downloadUrl);
        if (downloadResponse.ok) {
          transcript = await downloadResponse.json();
          console.log(`Got transcript via media_shortcuts: ${transcript?.length || 0} segments`);
        }
      }
    }
  }

  // Final fallback: try /recording/{id}/transcript/ endpoint
  if (!transcript && upload.recording_id) {
    console.log(`Trying to fetch transcript via /recording/transcript/ endpoint: ${upload.recording_id}`);
    const recordingTranscriptResponse = await fetch(`${RECALL_BASE_URL}/recording/${upload.recording_id}/transcript/`, {
      headers: { 'Authorization': `Token ${env.RECALL_API_KEY}` },
    });

    if (recordingTranscriptResponse.ok) {
      const recordingData = await recordingTranscriptResponse.json();
      // Recording transcript endpoint returns { transcript: { words: [...] } }
      if (recordingData.transcript?.words) {
        // Convert words format to segments format
        transcript = convertWordsToSegments(recordingData.transcript.words);
        console.log(`Got transcript via /recording/transcript/ endpoint: ${transcript.length} segments`);
      }
    } else {
      const errorText = await recordingTranscriptResponse.text();
      console.error(`Failed to fetch recording transcript: ${recordingTranscriptResponse.status} - ${errorText}`);
    }
  }

  if (!transcript) {
    return Response.json({ success: false, error: 'Transcript not ready yet' }, { status: 404 });
  }

  if (!Array.isArray(transcript)) {
    return Response.json({ success: false, error: 'Invalid transcript format' }, { status: 500 });
  }

  // Format transcript (same logic as bot transcripts)
  const formattedTranscript = transcript.map(segment => {
    const speaker = segment?.participant?.name || 'Unknown';
    const words = Array.isArray(segment?.words) ? segment.words : [];
    const text = words.map(w => w?.text || '').join(' ').trim();
    return text ? `${speaker}: ${text}` : null;
  }).filter(Boolean).join('\n\n');

  const participants = [...new Set(transcript.map(s => s?.participant?.name).filter(Boolean))];

  let duration = 0;
  if (transcript.length > 0) {
    const lastSegment = transcript[transcript.length - 1];
    const words = Array.isArray(lastSegment?.words) ? lastSegment.words : [];
    if (words.length > 0) {
      duration = words[words.length - 1]?.end_timestamp?.relative || 0;
    }
  }

  // Clean up both KV keys after successful retrieval
  await env.MEETING_BOTS.delete(`upload:${uploadId}`);
  await env.MEETING_BOTS.delete(`upload_status:${uploadId}`);
  console.log(`Transcript retrieved and KV cleaned up for upload: ${uploadId}`);

  return Response.json({
    success: true,
    transcript: formattedTranscript,
    participants,
    duration: Math.round(duration),
    meetingTitle: uploadRecord.meetingTitle,
    startTime: uploadRecord.createdAt,
    transcriptQuality: 'desktop_sdk',
  });
}

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

async function handleRecallWebhook(request, env) {
  const isValid = await verifyRecallWebhook(request.clone(), env.RECALL_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const body = await request.json();
  
  // Debug logging for webhook payloads
  console.log(`Recall webhook: event=${body.event}, desktop_sdk_upload=${body.data?.desktop_sdk_upload?.id}, bot=${body.data?.bot?.id}`);
  
  const event = body.event;
  const data = body.data || {};

  // Try multiple possible field paths for upload ID
  // Recall API uses 'desktop_sdk_upload' for local recordings
  const uploadId = data.desktop_sdk_upload?.id
    || data.sdk_upload?.id 
    || data.upload?.id 
    || data.sdk_upload_id 
    || data.upload_id;
  
  const botId = data.bot?.id;
  const recordingId = data.recording?.id;

  // Handle recording.done for SDK uploads (local recordings)
  // Must trigger async transcription - SDK upload with deepgram_streaming only records audio,
  // transcript is created via create_transcript/ call (same as cloud bots)
  if (event === 'recording.done' && uploadId && recordingId) {
    console.log(`SDK upload recording done: ${uploadId}, recording ${recordingId}`);

    // Check idempotency - skip if already triggered
    const existingStatus = await env.MEETING_BOTS.get(`upload_status:${uploadId}`, 'json');
    if (existingStatus?.asyncTriggeredAt) {
      console.log(`Async already triggered for upload ${uploadId}, skipping`);
      return new Response('OK', { status: 200 });
    }

    // Trigger async transcription (same pattern as bot_async_transcription sample app)
    try {
      const asyncResponse = await fetch(`${RECALL_BASE_URL}/recording/${recordingId}/create_transcript/`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${env.RECALL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: { recallai_async: {} },
          diarization: { use_separate_streams_when_available: true },
        }),
      });

      if (asyncResponse.ok) {
        const asyncResult = await asyncResponse.json();
        console.log(`Async transcription triggered for upload ${uploadId}, transcript ID: ${asyncResult.id}`);

        await env.MEETING_BOTS.put(
          `upload_status:${uploadId}`,
          JSON.stringify({
            recordingId,
            transcriptStatus: 'processing',
            asyncTranscriptId: asyncResult.id,
            asyncTriggeredAt: new Date().toISOString(),
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
      } else {
        const errorText = await asyncResponse.text();
        console.error(`Failed to trigger async transcription for upload ${uploadId}: ${asyncResponse.status} - ${errorText}`);

        // Still mark recording done so client knows upload completed
        await env.MEETING_BOTS.put(
          `upload_status:${uploadId}`,
          JSON.stringify({
            recordingId,
            transcriptStatus: 'done',
            asyncError: errorText,
            completedAt: new Date().toISOString(),
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
      }
    } catch (error) {
      console.error(`Error triggering async transcription for upload ${uploadId}: ${error.message}`);
      
      await env.MEETING_BOTS.put(
        `upload_status:${uploadId}`,
        JSON.stringify({
          recordingId,
          transcriptStatus: 'done',
          asyncError: error.message,
          completedAt: new Date().toISOString(),
        }),
        { expirationTtl: KV_TTL_SECONDS }
      );
    }

    return new Response('OK', { status: 200 });
  }

  // Handle recording.done for cloud bots - trigger async transcription
  if (event === 'recording.done' && botId && recordingId) {
    console.log(`Recording done for bot ${botId}, recording ${recordingId}`);

    // Check idempotency - skip if already triggered
    const statusRecord = await env.MEETING_BOTS.get(`bot_status:${botId}`, 'json');
    
    if (statusRecord?.asyncTriggeredAt) {
      console.log(`Async already triggered for bot ${botId}, skipping`);
      return new Response('OK', { status: 200 });
    }

    // Trigger async transcription with recallai_async
    try {
      const asyncResponse = await fetch(`${RECALL_BASE_URL}/recording/${recordingId}/create_transcript/`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${env.RECALL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: {
            recallai_async: {
              language_code: 'auto'
            }
          },
          diarization: {
            use_separate_streams_when_available: true
          }
        }),
      });

      if (asyncResponse.ok) {
        const asyncResult = await asyncResponse.json();
        console.log(`Async transcription triggered for bot ${botId}, transcript ID: ${asyncResult.id}`);

        // Update status with recording ID and async transcript ID
        await env.MEETING_BOTS.put(
          `bot_status:${botId}`,
          JSON.stringify({
            recordingId,
            transcriptStatus: 'async_processing',
            asyncTranscriptId: asyncResult.id,
            asyncTriggeredAt: new Date().toISOString(),
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
      } else {
        const errorText = await asyncResponse.text();
        console.error(`Failed to trigger async transcription: ${asyncResponse.status} - ${errorText}`);
        
        // Mark as captions_ready (fallback)
        await env.MEETING_BOTS.put(
          `bot_status:${botId}`,
          JSON.stringify({
            recordingId,
            transcriptStatus: 'captions_ready',
            asyncTriggeredAt: new Date().toISOString(),
            asyncError: errorText,
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
      }
    } catch (error) {
      console.error(`Error triggering async transcription: ${error.message}`);
      
      // Mark as captions_ready (fallback)
      await env.MEETING_BOTS.put(
        `bot_status:${botId}`,
        JSON.stringify({
          recordingId,
          transcriptStatus: 'captions_ready',
          asyncTriggeredAt: new Date().toISOString(),
          asyncError: error.message,
        }),
        { expirationTtl: KV_TTL_SECONDS }
      );
    }
  }

  // Handle transcript.done - mark async transcript ready
  if (event === 'transcript.done') {
    const transcriptId = data.transcript?.id;

    // Handle SDK upload transcript.done
    if (uploadId) {
      console.log(`Transcript done for SDK upload ${uploadId}, transcript ID: ${transcriptId}`);
      
      // Update upload_status key (separate from auth key for KV consistency)
      // This can safely create the record even if it doesn't exist - auth is in upload: key
      const statusRecord = await env.MEETING_BOTS.get(`upload_status:${uploadId}`, 'json') || {};
      await env.MEETING_BOTS.put(
        `upload_status:${uploadId}`,
        JSON.stringify({
          ...statusRecord,
          transcriptId,
          transcriptStatus: 'ready',
          transcriptReadyAt: new Date().toISOString(),
        }),
        { expirationTtl: KV_TTL_SECONDS }
      );
      console.log(`Marked SDK upload ${uploadId} transcript ready`);
      return new Response('OK', { status: 200 });
    }

    // Handle bot transcript.done
    if (botId) {
      console.log(`Transcript done for bot ${botId}, transcript ID: ${transcriptId}`);

      const statusRecord = await env.MEETING_BOTS.get(`bot_status:${botId}`, 'json');
      
      if (statusRecord) {
        // Only update if this is the async transcript we triggered
        if (statusRecord.asyncTranscriptId === transcriptId) {
          await env.MEETING_BOTS.put(
            `bot_status:${botId}`,
            JSON.stringify({
              ...statusRecord,
              transcriptStatus: 'async_ready',
            }),
            { expirationTtl: KV_TTL_SECONDS }
          );
          console.log(`Marked async transcript ready for bot ${botId}`);
        }
      }
    }
  }

  // Handle transcript.failed - mark async as failed
  if (event === 'transcript.failed') {
    const transcriptId = data.transcript?.id;
    const failureCode = data.data?.code || 'unknown';
    const failureSubCode = data.data?.sub_code;

    // Handle SDK upload transcript.failed (must handle BEFORE botId check)
    if (uploadId) {
      console.log(`Transcript failed for SDK upload ${uploadId}, transcript ID: ${transcriptId}, code: ${failureCode}`);

      const statusRecord = await env.MEETING_BOTS.get(`upload_status:${uploadId}`, 'json') || {};
      
      // Only update if this matches our async transcript (or if we have none stored)
      if (!statusRecord.asyncTranscriptId || statusRecord.asyncTranscriptId === transcriptId) {
        await env.MEETING_BOTS.put(
          `upload_status:${uploadId}`,
          JSON.stringify({
            ...statusRecord,
            transcriptStatus: 'failed',
            asyncError: failureSubCode ? `${failureCode}: ${failureSubCode}` : failureCode,
            transcriptFailedAt: new Date().toISOString(),
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
        console.log(`Marked SDK upload ${uploadId} transcript failed`);
      }
      return new Response('OK', { status: 200 });
    }

    // Handle bot transcript.failed
    if (botId) {
      console.log(`Transcript failed for bot ${botId}, transcript ID: ${transcriptId}, code: ${failureCode}`);

      const statusRecord = await env.MEETING_BOTS.get(`bot_status:${botId}`, 'json');
      
      if (statusRecord && statusRecord.asyncTranscriptId === transcriptId) {
        await env.MEETING_BOTS.put(
          `bot_status:${botId}`,
          JSON.stringify({
            ...statusRecord,
            transcriptStatus: 'async_failed',
            asyncError: failureSubCode ? `${failureCode}: ${failureSubCode}` : failureCode,
          }),
          { expirationTtl: KV_TTL_SECONDS }
        );
        console.log(`Marked async transcript failed for bot ${botId}`);
      }
    }
  }

  return new Response('OK', { status: 200 });
}

async function verifyRecallWebhook(request, secret) {
  // Recall uses Svix for webhooks - headers are svix-* not webhook-*
  const msgId = request.headers.get('svix-id') || request.headers.get('webhook-id');
  const msgTimestamp = request.headers.get('svix-timestamp') || request.headers.get('webhook-timestamp');
  const msgSignature = request.headers.get('svix-signature') || request.headers.get('webhook-signature');

  if (!msgId || !msgTimestamp || !msgSignature || !secret) {
    return false;
  }

  // Replay protection: reject timestamps older than 5 minutes or in the future
  const timestampSec = parseInt(msgTimestamp, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (isNaN(timestampSec) || Math.abs(nowSec - timestampSec) > 300) {
    console.warn('Webhook rejected: timestamp outside valid window');
    return false;
  }

  const base64Key = secret.startsWith('whsec_') ? secret.slice(6) : secret;

  let keyData;
  try {
    keyData = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const payload = await request.text();
  const toSign = `${msgId}.${msgTimestamp}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const passedSigs = msgSignature.split(' ');
  for (const versionedSig of passedSigs) {
    const [version, signature] = versionedSig.split(',');
    if (version === 'v1' && signature === expectedSig) {
      return true;
    }
  }

  return false;
}
