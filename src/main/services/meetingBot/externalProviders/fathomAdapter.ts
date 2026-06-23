/**
 * Fathom Adapter
 *
 * Imports meeting transcripts from Fathom's REST API.
 * Fathom is simpler than Fireflies - transcripts are included in the list response.
 *
 * API Docs: https://developers.fathom.ai/
 * Rate Limit: 60 requests/minute
 */

import { createScopedLogger } from '@core/logger';
import type {
  ProviderAdapter,
  ConnectionTestResult,
  FetchTranscriptsResult,
  ExternalTranscript,
} from './types';
import { classifyError, parseTimestampToSeconds } from './types';

const log = createScopedLogger({ service: 'fathom-adapter' });

const BASE_URL = 'https://api.fathom.ai/external/v1';

/** Fathom API response types */
interface FathomSpeaker {
  display_name: string;
  matched_calendar_invitee_email?: string;
}

interface FathomTranscriptEntry {
  speaker: FathomSpeaker;
  text: string;
  timestamp: string; // "HH:MM:SS" format
}

interface FathomCalendarInvitee {
  name: string;
  email: string;
  email_domain?: string;
  is_external?: boolean;
}

interface FathomSummary {
  template_name?: string;
  markdown_formatted?: string;
}

interface FathomActionItem {
  description: string;
  completed?: boolean;
  assignee?: { name: string; email: string };
}

interface FathomMeeting {
  recording_id: number;
  title?: string;
  meeting_title?: string;
  created_at: string;
  scheduled_start_time?: string;
  recording_start_time?: string;
  recording_end_time?: string;
  calendar_invitees?: FathomCalendarInvitee[];
  transcript?: FathomTranscriptEntry[];
  default_summary?: FathomSummary;
  action_items?: FathomActionItem[];
  url?: string;
}

interface FathomListResponse {
  items: FathomMeeting[];
  next_cursor?: string | null;
  limit?: number;
}

/**
 * Create a Fathom adapter instance.
 */
export function createFathomAdapter(apiKey: string): ProviderAdapter {
  const headers = {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
  };

  /**
   * Make an authenticated request to Fathom API.
   */
  async function fathomFetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<{ data: T | null; status: number; error?: string; retryAfter?: number }> {
    const url = `${BASE_URL}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...options.headers,
        },
      });

      // Extract rate limit headers
      const retryAfter = response.headers.get('RateLimit-Reset');

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          data: null,
          status: response.status,
          error: errorText,
          retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
        };
      }

      const data = (await response.json()) as T;
      return { data, status: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      log.error({ error, endpoint }, 'Fathom API request failed');
      return { data: null, status: 0, error: message };
    }
  }

  /**
   * Format Fathom transcript entries to standard format.
   */
  function formatTranscript(entries: FathomTranscriptEntry[]): string {
    return entries
      .map((entry) => {
        const timestamp = entry.timestamp || '00:00:00';
        const speaker = entry.speaker?.display_name || 'Speaker';
        const text = entry.text?.trim() || '';
        return `[${timestamp}] ${speaker}: ${text}`;
      })
      .join('\n');
  }

  /**
   * Calculate duration from start/end times.
   */
  function calculateDuration(meeting: FathomMeeting): number {
    if (meeting.recording_start_time && meeting.recording_end_time) {
      const start = new Date(meeting.recording_start_time).getTime();
      const end = new Date(meeting.recording_end_time).getTime();
      return Math.floor((end - start) / 1000);
    }
    // Estimate from transcript if available
    if (meeting.transcript && meeting.transcript.length > 0) {
      const lastEntry = meeting.transcript[meeting.transcript.length - 1];
      return parseTimestampToSeconds(lastEntry.timestamp);
    }
    return 0;
  }

  /**
   * Convert Fathom meeting to normalized ExternalTranscript.
   */
  function normalizeTranscript(meeting: FathomMeeting): ExternalTranscript {
    const participants = meeting.calendar_invitees?.map((inv) => inv.name || inv.email) || [];
    const title = meeting.meeting_title || meeting.title || 'Meeting';
    const startTime = meeting.recording_start_time || meeting.scheduled_start_time || meeting.created_at;

    return {
      externalId: String(meeting.recording_id),
      provider: 'fathom',
      title,
      participants,
      startTime,
      duration: calculateDuration(meeting),
      transcript: meeting.transcript ? formatTranscript(meeting.transcript) : '',
      summary: meeting.default_summary?.markdown_formatted,
      actionItems: meeting.action_items?.map((item) => item.description),
      meetingUrl: meeting.url,
    };
  }

  return {
    name: 'fathom',

    async testConnection(): Promise<ConnectionTestResult> {
      log.info('Testing Fathom connection');

      // Try to list meetings with limit 1
      const result = await fathomFetch<FathomListResponse>(
        '/meetings?limit=1&include_transcript=false'
      );

      if (result.status === 401 || result.status === 403) {
        return {
          success: false,
          error: 'Invalid API key',
          message: 'Your Fathom API key is invalid. Please check and try again.',
        };
      }

      if (!result.data) {
        const classification = classifyError(result.status);
        return {
          success: false,
          error: result.error || 'Connection failed',
          message:
            classification === 'rate_limited'
              ? 'Rate limited. Please try again in a moment.'
              : 'Could not connect to Fathom. Please check your internet connection.',
        };
      }

      log.info('Fathom connection successful');
      return {
        success: true,
        message: 'Connected to Fathom successfully.',
      };
    },

    async fetchTranscripts(since: Date, cursor?: string): Promise<FetchTranscriptsResult> {
      // Add 1 hour overlap to catch transcripts still processing on previous sync
      const fromDate = new Date(since.getTime() - 60 * 60 * 1000);
      log.info({ since: fromDate.toISOString(), cursor }, 'Fetching Fathom transcripts');

      // Build query params
      const params = new URLSearchParams({
        include_transcript: 'true',
        include_action_items: 'true',
        include_summary: 'true',
        created_after: fromDate.toISOString(),
      });

      if (cursor) {
        params.set('cursor', cursor);
      }

      const result = await fathomFetch<FathomListResponse>(`/meetings?${params.toString()}`);

      if (!result.data) {
        const classification = classifyError(result.status);
        log.warn({ status: result.status, error: result.error }, 'Failed to fetch Fathom transcripts');

        return {
          success: false,
          transcripts: [],
          error:
            classification === 'auth_invalid'
              ? 'Fathom API key is invalid'
              : classification === 'rate_limited'
                ? 'Rate limited by Fathom'
                : result.error || 'Failed to fetch transcripts',
        };
      }

      const transcripts = result.data.items
        .filter((meeting) => meeting.transcript && meeting.transcript.length > 0)
        .map(normalizeTranscript);

      log.info({ count: transcripts.length, nextCursor: result.data.next_cursor }, 'Fetched Fathom transcripts');

      return {
        success: true,
        transcripts,
        nextCursor: result.data.next_cursor || undefined,
      };
    },
  };
}
