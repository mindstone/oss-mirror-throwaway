#!/usr/bin/env node
/**
 * RebelMeetings MCP Server
 *
 * Meeting workflow: today's meetings, save/find prep notes, meeting history/missed, schedule recording bot, live transcript.
 *
 * Tools (10):
 * - rebel_meetings_sync
 * - rebel_meetings_today
 * - rebel_meetings_save_prep
 * - focus_enrich_meeting_prep
 * - rebel_meetings_find_prep
 * - rebel_meetings_history
 * - rebel_meetings_missed
 * - rebel_meetings_schedule_bot
 * - rebel_meetings_live_transcript
 * - rebel_meetings_live_send_chat
 */
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const fs = require('node:fs');
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const statePath = process.env.MINDSTONE_REBEL_BRIDGE_STATE;

const loadBridgeState = () => {
  if (!statePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || !parsed.token) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const bridgeState = loadBridgeState();

if (!bridgeState) {
  console.error('[RebelMeetings] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelMeetings',
  version: '1.0.0',
  description: `Meeting workflow: today's meetings, save/find prep notes, meeting history/missed, schedule recording bot.`
});

// Helper: Make bridge requests
const bridgeRequest = async (toolName, path, options = {}) => {
  const { method = 'POST', body } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  const response = await fetch(`${bridgeBaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    let detail = 'Request failed.';
    try {
      const payload = await response.json();
      detail = payload?.error ?? detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(`[${toolName}] ${detail || `Request failed (${response.status})`}`);
  }

  return response.json();
};

// =============================================================================
// Tool Names
// =============================================================================
const TOOL_NAMES = {
  sync: 'rebel_meetings_sync',
  get: 'rebel_meetings_today',
  savePrep: 'rebel_meetings_save_prep',
  enrichMeetingPrep: 'focus_enrich_meeting_prep',
  findPrep: 'rebel_meetings_find_prep',
  history: 'rebel_meetings_history',
  missed: 'rebel_meetings_missed',
  scheduleBot: 'rebel_meetings_schedule_bot',
};

// =============================================================================
// Schemas
// =============================================================================

// Helper to coerce null to undefined (LLMs sometimes pass null instead of omitting)
const nullToUndefined = (val) => (val === null ? undefined : val);

// Schema for a cached meeting
const cachedMeetingSchema = z.object({
  id: z.string().min(1).describe('Composite ID: calendarSource:eventId'),
  calendarEventId: z.string().min(1).describe('Provider event ID'),
  calendarSource: z.string().min(1).describe('Calendar provider (google, microsoft)'),
  title: z.string().min(1),
  startTime: z.string().min(1).describe('ISO 8601 datetime'),
  endTime: z.string().min(1).describe('ISO 8601 datetime'),
  meetingUrl: z.preprocess(nullToUndefined, z.string().optional()).describe('Video call URL if available'),
  participants: z.preprocess(nullToUndefined, z.array(z.string()).optional().default([])).describe('List of participant names/emails'),
});

const syncSchema = z.object({
  meetings: z.array(cachedMeetingSchema).describe('Array of meetings to cache'),
  syncWarnings: z.array(z.string()).optional().describe('Warnings from calendar sources that failed (e.g. "CalendarMCP: auth error")'),
});

const getSchema = z.object({});

const savePrepSchema = z.object({
  meetingStartTime: z.string().min(1).describe('ISO 8601 datetime with timezone, e.g. "2025-01-15T14:30:00Z"'),
  meetingTitle: z.string().min(1).describe('Meeting title for filename and frontmatter'),
  prepContent: z.string().min(1).describe('Markdown body only (no frontmatter, no ---)'),
  participants: z.array(z.string()).optional().describe('List of participant names/emails'),
  meetingId: z.string().optional().describe('Calendar ID for linking (e.g., "google:abc123"). Enables auto-linking if meeting is in 24h cache.'),
});

const enrichMeetingPrepSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe('Prep file path relative to workspace coreDirectory (e.g. memory/sources/2026/04-Apr/14/...-prep.md).'),
  goalAlignment: z
    .array(
      z.object({
        goal: z.string().min(1).describe('Goal text to align against'),
        space: z.string().min(1).describe('Space name that owns the goal'),
      }),
    )
    .describe('Array of goal/space alignments (can be empty).'),
  meetingUtility: z
    .enum(['productive', 'blocker', 'noise', 'travel'])
    .describe('Utility classification for the meeting.'),
});

const findPrepSchema = z.object({
  meetingDate: z.string().optional().describe('Date to search (YYYY-MM-DD or ISO 8601). Searches that date\'s folder.'),
  meetingTitle: z.string().optional().describe('Title for fuzzy matching. Filters results by similarity.'),
  meetingId: z.string().optional().describe('Calendar ID for exact frontmatter match (most reliable).'),
});

const historySchema = z.object({
  startDate: z.string().optional().describe('Start of date range (ISO 8601). Defaults to 7 days ago.'),
  endDate: z.string().optional().describe('End of date range (ISO 8601). Defaults to 7 days from now.'),
});

const missedSchema = z.object({
  since: z.string().optional().describe('Only include meetings after this date (ISO 8601). Defaults to 7 days ago.'),
});

const scheduleBotSchema = z.object({
  meetingUrl: z.string().min(1).describe('Video call URL (Zoom, Meet, Teams, etc.)'),
  meetingTitle: z.string().optional().describe('Meeting title for reference'),
  scheduledFor: z.string().optional().describe('When the meeting starts (ISO 8601). Bot will join at this time.'),
});

// =============================================================================
// Tool Registrations
// =============================================================================

// Sync meetings (internal - called by calendar sync automation ONLY)
server.registerTool(TOOL_NAMES.sync, {
  title: 'Sync meetings to cache',
  description: `INTERNAL — DO NOT CALL during regular conversations. This is only for the dedicated calendar-sync automation.

The meeting cache is populated automatically by a background scheduler every 15 minutes. Calling this tool overwrites that cache and loses RSVP filtering (unconfirmed meetings would appear on the homepage).

To READ today's meetings, use rebel_meetings_today instead.`,
  inputSchema: syncSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.sync, '/meetings/populate', {
    method: 'POST',
    body: {
      meetings: input.meetings,
      syncWarnings: input.syncWarnings || []
    }
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        count: result.count,
        warnings: input.syncWarnings || [],
      }, null, 2)
    }]
  };
});

// Get today's meetings
server.registerTool(TOOL_NAMES.get, {
  title: "Get today's meetings",
  description: `View meetings scheduled for the next 24 hours (rolling window, not calendar day).

Returns JSON with meetings and their prep status.

NOTE: This only shows the next 24h of meetings. For meetings further out, use your calendar MCPs directly.`,
  inputSchema: getSchema,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.get, '/meetings/today', { method: 'GET' });

  const meetings = (result.meetings || []).map(m => ({
    id: m.id,
    title: m.title,
    startTime: m.startTime,
    endTime: m.endTime,
    meetingUrl: m.meetingUrl,
    participants: m.participants,
    prepPath: m.prepPath,
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ meetings, count: meetings.length }, null, 2)
    }]
  };
});

// Save meeting prep
server.registerTool(TOOL_NAMES.savePrep, {
  title: 'Save meeting prep',
  description: `Save meeting prep with consistent naming and frontmatter.

Works for ANY future meeting - not just those in the 24h cache.
Files are stored permanently in your workspace.

IMPORTANT:
- Use rebel_meetings_find_prep first to check if prep already exists (no silent overwrites)
- If file exists, this tool returns an error with the existing path

Path pattern: meeting-transcripts/YYYY/MM/YYYY-MM-DD-HHmm-{slug}-prep.md
All times are stored in UTC.`,
  inputSchema: savePrepSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  // Custom fetch to preserve full response on 409 collision
  // (bridgeRequest throws on non-2xx, but we need the 409 body)
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  try {
    const response = await fetch(`${bridgeBaseUrl}/meetings/save-prep`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        meetingStartTime: input.meetingStartTime,
        meetingTitle: input.meetingTitle,
        prepContent: input.prepContent,
        participants: input.participants,
        meetingId: input.meetingId,
      })
    });

    const result = await response.json();

    // Return full JSON for both success and collision (409)
    if (response.ok || response.status === 409) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: !response.ok
      };
    }

    // Other errors
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: result.error || 'Save failed' }, null, 2)
      }],
      isError: true
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Enrich meeting prep frontmatter with goal alignment + utility classification
server.registerTool(TOOL_NAMES.enrichMeetingPrep, {
  title: 'Enrich meeting prep classification',
  description: "Classify a meeting prep document against user goals. Writes goal alignment and utility classification to the prep doc's frontmatter.",
  inputSchema: enrichMeetingPrepSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.enrichMeetingPrep, '/focus/enrich-prep-doc', {
      method: 'POST',
      body: {
        filePath: input.filePath,
        goalAlignment: input.goalAlignment,
        meetingUtility: input.meetingUtility,
      },
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2),
      }],
      isError: true,
    };
  }
});

// Find meeting prep
server.registerTool(TOOL_NAMES.findPrep, {
  title: 'Find meeting prep',
  description: `Search for existing prep files by date, title, or meetingId.

At least one of meetingDate or meetingId is required.

Search strategies:
- meetingId: Exact match on frontmatter (most reliable, searches all prep files)
- meetingDate: Searches specific date folder
- meetingTitle: Fuzzy match, filters results by similarity score

Returns JSON with matching files and their frontmatter.`,
  inputSchema: findPrepSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  if (!input.meetingDate && !input.meetingId) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: 'At least one of meetingDate or meetingId is required.' }, null, 2)
      }],
      isError: true
    };
  }

  try {
    const result = await bridgeRequest(TOOL_NAMES.findPrep, '/meetings/find-prep', {
      method: 'POST',
      body: {
        meetingDate: input.meetingDate,
        meetingTitle: input.meetingTitle,
        meetingId: input.meetingId,
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Meeting history
server.registerTool(TOOL_NAMES.history, {
  title: 'Get meeting history with transcript status',
  description: `Query meetings from the history store with their transcript status.

Use this to answer: "What meetings did I have this week?" or "Which meetings got captured?"

Unlike rebel_meetings_today (calendar-focused, next 24h), this tool:
- Returns meetings from the history store (not just calendar cache)
- Includes transcript status: captured, missed, pending, upcoming
- Covers a date range (default ±7 days)

Note: History only includes meetings that were in the calendar cache while the app was running.`,
  inputSchema: historySchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.history, '/meetings/history', {
      method: 'POST',
      body: {
        startDate: input.startDate,
        endDate: input.endDate,
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Missed meetings
server.registerTool(TOOL_NAMES.missed, {
  title: 'Get missed meetings',
  description: `Find meetings that didn't get transcripts captured.

Use this to answer: "What meetings did I miss capturing?" or "Which calls don't have transcripts?"

Returns meetings where:
- The meeting has ended
- No transcript was captured (status = 'missed')

Helpful for identifying gaps in meeting coverage.`,
  inputSchema: missedSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.missed, '/meetings/missed', {
      method: 'POST',
      body: {
        since: input.since,
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Schedule recording bot
server.registerTool(TOOL_NAMES.scheduleBot, {
  title: 'Schedule a recording bot',
  description: `Schedule Rebel's meeting bot to join and record a video call.

Use this when the user asks: "Send Rebel to my meeting" or "Schedule a bot for my planning call"

Input:
- meetingUrl: Required. The video call URL (Zoom, Meet, Teams supported)
- meetingTitle: Optional. Helps identify the recording later
- scheduledFor: Optional. If provided, bot joins at that time. Otherwise joins immediately.

The bot will:
1. Join the meeting at the scheduled time
2. Record and transcribe the conversation
3. Save the transcript to your workspace

Note: If a bot is already scheduled for this meeting URL, returns the existing bot ID (no duplicates).`,
  inputSchema: scheduleBotSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.scheduleBot, '/meetings/schedule-bot', {
      method: 'POST',
      body: {
        meetingUrl: input.meetingUrl,
        meetingTitle: input.meetingTitle,
        scheduledFor: input.scheduledFor,
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// =============================================================================
// rebel_meetings_live_transcript
// =============================================================================
server.registerTool('rebel_meetings_live_transcript', {
  title: 'Get live meeting transcript',
  description: `**REAL-TIME ACCESS**: Get the transcript from a meeting that is CURRENTLY IN PROGRESS and being recorded RIGHT NOW by Rebel's meeting bot.

⚡ USE THIS TOOL when the user asks about what's happening in their CURRENT/ACTIVE/ONGOING meeting:
- "What did Tom just say?" (in the meeting happening now)
- "What's being discussed in my current call?"
- "Summarize the meeting so far"
- "What was the last topic in this meeting?"
- "Who's in my current meeting?"

🚫 DO NOT use this for:
- Past/completed meetings → Use rebel_sources_search or rebel_files_read instead
- Scheduled future meetings → Use rebel_meetings_today
- Meetings from other apps → Use Granola or Fathom tools

Returns JSON with:
- hasActiveMeeting: true/false - whether Rebel's bot is currently recording
- meetings[]: Array of active recordings, each with:
  - meetingTitle: Name of the meeting
  - participants: Array of speaker names detected so far
  - elapsedMinutes: How long the meeting has been going
  - wordCount: Number of words in transcript so far
  - transcript: The actual transcript text (most recent content if very long)
  - hasTranscript: false if recording just started and no speech captured yet

TIMING: Transcript updates every 30 seconds. If hasTranscript is false, the meeting may have just started - wait ~30 seconds and try again.`,
  annotations: { readOnlyHint: true }
}, async () => {
    try {
      const result = await bridgeRequest('rebel_meetings_live_transcript', '/meetings/live-transcript', {
        method: 'GET'
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// =============================================================================
// rebel_meetings_live_send_chat
// =============================================================================
server.registerTool('rebel_meetings_live_send_chat', {
  title: 'Send message to live meeting chat',
  description: `Send a message to the chat of a meeting that is CURRENTLY IN PROGRESS and being recorded by Rebel's meeting bot.

This posts a message to the meeting platform's chat (Zoom chat, Teams chat, Google Meet chat) — NOT to a Rebel conversation.

⚡ USE THIS TOOL ONLY when the user EXPLICITLY asks you to send/post something to the meeting chat:
- "Send that to the meeting chat"
- "Post a summary in the chat"
- "Share that link in the meeting chat"
- "Can you put that in the chat?"

🚫 DO NOT use this tool:
- Without an explicit user request to send to chat
- To proactively share information (wait for the user to ask)
- For past/completed meetings
- To send to a Rebel conversation (just reply normally instead)

Returns JSON with:
- success: true/false
- error: Error message if failed
- rateLimited: true if the chat API rate limit was hit (try again in a moment)`,
  inputSchema: z.object({
    message: z.string().min(1).describe('The message to send to the meeting chat')
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, async ({ message }) => {
    try {
      const result = await bridgeRequest('rebel_meetings_live_send_chat', '/meetings/send-chat', {
        method: 'POST',
        body: { message }
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelMeetings] Server started');
  })
  .catch((error) => {
    console.error('[RebelMeetings] Failed to start', error);
    process.exit(1);
  });
